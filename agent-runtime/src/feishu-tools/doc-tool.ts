/**
 * ClawBot Cloud — Feishu Document MCP Tool
 *
 * Registers the `feishu_doc` MCP tool for interacting with Feishu/Lark documents.
 * Uses the Lark SDK (@larksuiteoapi/node-sdk) for all API operations.
 *
 * Actions: read, write, append, create, list_blocks, get_block, update_block,
 * delete_block, create_table, write_table_cells, create_table_with_values, upload_image
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type * as Lark from '@larksuiteoapi/node-sdk';
import { z } from 'zod';

// ── Helpers ─────────────────────────────────────────────────────────────────

function json(data: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
  };
}

function errorResult(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  return {
    content: [{ type: 'text' as const, text: JSON.stringify({ error: message }, null, 2) }],
    isError: true as const,
  };
}

/**
 * Extract the document token from a Feishu URL or return the input as-is.
 * Handles URLs like: https://xxx.feishu.cn/docx/ABC123def
 */
function extractDocumentToken(input: string): string {
  const match = input.match(/\/docx\/([A-Za-z0-9]+)/);
  return match ? match[1] : input;
}

const BLOCK_TYPE_NAMES: Record<number, string> = {
  1: 'Page',
  2: 'Text',
  3: 'Heading1',
  4: 'Heading2',
  5: 'Heading3',
  12: 'Bullet',
  13: 'Ordered',
  14: 'Code',
  15: 'Quote',
  17: 'Todo',
  18: 'Bitable',
  21: 'Diagram',
  22: 'Divider',
  23: 'File',
  27: 'Image',
  30: 'Sheet',
  31: 'Table',
  32: 'TableCell',
};

// Block types with structured content not captured in plain text rawContent
const STRUCTURED_BLOCK_TYPES = new Set([14, 18, 21, 23, 27, 30, 31, 32]);

// ── Core Functions ──────────────────────────────────────────────────────────

async function readDoc(client: Lark.Client, docToken: string) {
  const [contentRes, infoRes, blocksRes] = await Promise.all([
    client.docx.document.rawContent({ path: { document_id: docToken } }),
    client.docx.document.get({ path: { document_id: docToken } }),
    client.docx.documentBlock.list({ path: { document_id: docToken } }),
  ]);

  if (contentRes.code !== 0) {
    throw new Error(contentRes.msg);
  }

  const blocks = blocksRes.data?.items ?? [];
  const blockCounts: Record<string, number> = {};
  const structuredTypes: string[] = [];

  for (const b of blocks) {
    const type = b.block_type ?? 0;
    const name = BLOCK_TYPE_NAMES[type] || `type_${type}`;
    blockCounts[name] = (blockCounts[name] || 0) + 1;
    if (STRUCTURED_BLOCK_TYPES.has(type) && !structuredTypes.includes(name)) {
      structuredTypes.push(name);
    }
  }

  let hint: string | undefined;
  if (structuredTypes.length > 0) {
    hint = `This document contains ${structuredTypes.join(', ')} which are NOT included in the plain text above. Use feishu_doc with action: "list_blocks" to get full content.`;
  }

  return {
    title: infoRes.data?.document?.title,
    content: contentRes.data?.content,
    revision_id: infoRes.data?.document?.revision_id,
    block_count: blocks.length,
    block_types: blockCounts,
    ...(hint && { hint }),
  };
}

async function createDoc(client: Lark.Client, title: string, folderToken?: string) {
  const res = await client.docx.document.create({
    data: { title, folder_token: folderToken },
  });
  if (res.code !== 0) {
    throw new Error(res.msg);
  }

  const doc = res.data?.document;
  const docToken = doc?.document_id;
  if (!docToken) {
    throw new Error('Document creation succeeded but no document_id was returned');
  }

  return {
    document_id: docToken,
    title: doc?.title,
    url: `https://feishu.cn/docx/${docToken}`,
  };
}

/**
 * Convert markdown to Feishu blocks using the Lark SDK convert API.
 */
async function convertMarkdown(client: Lark.Client, markdown: string) {
  const res = await client.docx.document.convert({
    data: { content_type: 'markdown', content: markdown },
  });
  if (res.code !== 0) {
    throw new Error(res.msg);
  }
  return {
    blocks: res.data?.blocks ?? [],
    firstLevelBlockIds: res.data?.first_level_block_ids ?? [],
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function sortBlocksByFirstLevel(blocks: any[], firstLevelIds: string[]): any[] {
  if (!firstLevelIds || firstLevelIds.length === 0) return blocks;
  const sorted = firstLevelIds.map((id) => blocks.find((b) => b.block_id === id)).filter(Boolean);
  const sortedIds = new Set(firstLevelIds);
  const remaining = blocks.filter((b) => !sortedIds.has(b.block_id));
  return [...sorted, ...remaining];
}

/**
 * Insert blocks into a document using the Descendant API.
 * This supports complex block types (tables, nested content).
 */
async function insertBlocksWithDescendant(
  client: Lark.Client,
  docToken: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  blocks: any[],
  firstLevelBlockIds: string[],
  { parentBlockId = docToken, index = -1 }: { parentBlockId?: string; index?: number } = {},
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<{ children: any[] }> {
  if (blocks.length === 0) {
    return { children: [] };
  }

  // Clean blocks for descendant API: remove read-only fields
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const descendants = blocks.map((block: any) => {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { parent_id, children, ...rest } = block;
    return rest;
  });

  const res = await client.docx.documentBlockDescendant.create({
    path: { document_id: docToken, block_id: parentBlockId },
    data: { children_id: firstLevelBlockIds, descendants, index },
  });

  if (res.code !== 0) {
    throw new Error(`${res.msg} (code: ${res.code})`);
  }

  return { children: res.data?.children ?? [] };
}

/**
 * Fallback insert: insert blocks one at a time using the Children API.
 * Used when the Descendant API fails (e.g., older API versions).
 */
async function insertBlocksOneByOne(
  client: Lark.Client,
  docToken: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  blocks: any[],
  parentBlockId?: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<{ children: any[] }> {
  const blockId = parentBlockId ?? docToken;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const allInserted: any[] = [];

  for (const block of blocks) {
    // Filter out table/table-cell block types that cannot be created via children API
    if (block.block_type === 31 || block.block_type === 32) continue;

    const res = await client.docx.documentBlockChildren.create({
      path: { document_id: docToken, block_id: blockId },
      data: { children: [block] },
    });
    if (res.code !== 0) {
      throw new Error(res.msg);
    }
    allInserted.push(...(res.data?.children ?? []));
  }

  return { children: allInserted };
}

/**
 * Convert markdown and insert into a document.
 * Tries the Descendant API first, falls back to one-by-one insertion.
 */
async function convertAndInsert(
  client: Lark.Client,
  docToken: string,
  markdown: string,
  parentBlockId?: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<{ blocks_added: number; children: any[] }> {
  const { blocks, firstLevelBlockIds } = await convertMarkdown(client, markdown);
  if (blocks.length === 0) {
    return { blocks_added: 0, children: [] };
  }

  const sortedBlocks = sortBlocksByFirstLevel(blocks, firstLevelBlockIds);

  try {
    const { children } = await insertBlocksWithDescendant(
      client,
      docToken,
      sortedBlocks,
      firstLevelBlockIds,
      { parentBlockId: parentBlockId ?? docToken },
    );
    return { blocks_added: blocks.length, children };
  } catch {
    // Fallback: insert blocks one by one
    const { children } = await insertBlocksOneByOne(
      client,
      docToken,
      sortedBlocks,
      parentBlockId,
    );
    return { blocks_added: blocks.length, children };
  }
}

async function clearDocumentContent(client: Lark.Client, docToken: string): Promise<number> {
  const existing = await client.docx.documentBlock.list({
    path: { document_id: docToken },
  });
  if (existing.code !== 0) {
    throw new Error(existing.msg);
  }

  const childIds =
    existing.data?.items
      ?.filter((b) => b.parent_id === docToken && b.block_type !== 1)
      .map((b) => b.block_id) ?? [];

  if (childIds.length > 0) {
    const res = await client.docx.documentBlockChildren.batchDelete({
      path: { document_id: docToken, block_id: docToken },
      data: { start_index: 0, end_index: childIds.length },
    });
    if (res.code !== 0) {
      throw new Error(res.msg);
    }
  }

  return childIds.length;
}

async function writeDoc(client: Lark.Client, docToken: string, markdown: string) {
  const deleted = await clearDocumentContent(client, docToken);
  const { blocks_added, children: _ } = await convertAndInsert(client, docToken, markdown);

  return {
    success: true,
    blocks_deleted: deleted,
    blocks_added,
  };
}

async function appendDoc(client: Lark.Client, docToken: string, markdown: string) {
  const { blocks_added } = await convertAndInsert(client, docToken, markdown);

  if (blocks_added === 0) {
    throw new Error('Content is empty');
  }

  return {
    success: true,
    blocks_added,
  };
}

async function listBlocks(client: Lark.Client, docToken: string) {
  const res = await client.docx.documentBlock.list({
    path: { document_id: docToken },
  });
  if (res.code !== 0) {
    throw new Error(res.msg);
  }

  // Annotate blocks with human-readable type names
  const blocks =
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    res.data?.items?.map((b: any) => ({
      ...b,
      block_type_name: BLOCK_TYPE_NAMES[b.block_type as number] || `type_${b.block_type}`,
    })) ?? [];

  return { blocks };
}

async function getBlock(client: Lark.Client, docToken: string, blockId: string) {
  const res = await client.docx.documentBlock.get({
    path: { document_id: docToken, block_id: blockId },
  });
  if (res.code !== 0) {
    throw new Error(res.msg);
  }

  return { block: res.data?.block };
}

async function updateBlock(
  client: Lark.Client,
  docToken: string,
  blockId: string,
  content: string,
) {
  // Verify the block exists first
  const blockInfo = await client.docx.documentBlock.get({
    path: { document_id: docToken, block_id: blockId },
  });
  if (blockInfo.code !== 0) {
    throw new Error(blockInfo.msg);
  }

  const res = await client.docx.documentBlock.patch({
    path: { document_id: docToken, block_id: blockId },
    data: {
      update_text_elements: {
        elements: [{ text_run: { content } }],
      },
    },
  });
  if (res.code !== 0) {
    throw new Error(res.msg);
  }

  return { success: true, block_id: blockId };
}

async function deleteBlock(client: Lark.Client, docToken: string, blockId: string) {
  // Get the block to find its parent
  const blockInfo = await client.docx.documentBlock.get({
    path: { document_id: docToken, block_id: blockId },
  });
  if (blockInfo.code !== 0) {
    throw new Error(blockInfo.msg);
  }

  const parentId = blockInfo.data?.block?.parent_id ?? docToken;

  // Get children of the parent to find the block's index
  const children = await client.docx.documentBlockChildren.get({
    path: { document_id: docToken, block_id: parentId },
  });
  if (children.code !== 0) {
    throw new Error(children.msg);
  }

  const items = children.data?.items ?? [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const index = items.findIndex((item: any) => item.block_id === blockId);
  if (index === -1) {
    throw new Error('Block not found among parent children');
  }

  const res = await client.docx.documentBlockChildren.batchDelete({
    path: { document_id: docToken, block_id: parentId },
    data: { start_index: index, end_index: index + 1 },
  });
  if (res.code !== 0) {
    throw new Error(res.msg);
  }

  return { success: true, deleted_block_id: blockId };
}

async function createTable(
  client: Lark.Client,
  docToken: string,
  rowSize: number,
  columnSize: number,
) {
  const res = await client.docx.documentBlockChildren.create({
    path: { document_id: docToken, block_id: docToken },
    data: {
      children: [
        {
          block_type: 31,
          table: {
            property: {
              row_size: rowSize,
              column_size: columnSize,
            },
          },
        },
      ],
    },
  });

  if (res.code !== 0) {
    throw new Error(res.msg);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tableBlock = (res.data?.children as any[] | undefined)?.find((b) => b.block_type === 31);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cells = (tableBlock?.children as any[] | undefined) ?? [];

  return {
    success: true,
    table_block_id: tableBlock?.block_id,
    row_size: rowSize,
    column_size: columnSize,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    table_cell_block_ids: cells.map((c: any) => c.block_id).filter(Boolean),
  };
}

async function writeTableCells(
  client: Lark.Client,
  docToken: string,
  tableBlockId: string,
  values: string[][],
) {
  if (!values.length || !values[0]?.length) {
    throw new Error('values must be a non-empty 2D array');
  }

  const tableRes = await client.docx.documentBlock.get({
    path: { document_id: docToken, block_id: tableBlockId },
  });
  if (tableRes.code !== 0) {
    throw new Error(tableRes.msg);
  }

  const tableBlock = tableRes.data?.block;
  if (tableBlock?.block_type !== 31) {
    throw new Error('table_block_id is not a table block');
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tableData = (tableBlock as any).table;
  const rows = tableData?.property?.row_size as number | undefined;
  const cols = tableData?.property?.column_size as number | undefined;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cellIds = (tableData?.cells as any[] | undefined) ?? [];

  if (!rows || !cols || !cellIds.length) {
    throw new Error(
      'Table cell IDs unavailable. Use list_blocks/get_block to inspect the table structure.',
    );
  }

  const writeRows = Math.min(values.length, rows);
  let written = 0;

  for (let r = 0; r < writeRows; r++) {
    const rowValues = values[r] ?? [];
    const writeCols = Math.min(rowValues.length, cols);

    for (let c = 0; c < writeCols; c++) {
      const cellId = cellIds[r * cols + c];
      if (!cellId) continue;

      // Clear existing children in the cell
      const childrenRes = await client.docx.documentBlockChildren.get({
        path: { document_id: docToken, block_id: cellId },
      });
      if (childrenRes.code !== 0) {
        throw new Error(childrenRes.msg);
      }

      const existingChildren = childrenRes.data?.items ?? [];
      if (existingChildren.length > 0) {
        const delRes = await client.docx.documentBlockChildren.batchDelete({
          path: { document_id: docToken, block_id: cellId },
          data: { start_index: 0, end_index: existingChildren.length },
        });
        if (delRes.code !== 0) {
          throw new Error(delRes.msg);
        }
      }

      // Insert text content using the convert API
      const text = rowValues[c] ?? '';
      const converted = await convertMarkdown(client, text);
      const sorted = sortBlocksByFirstLevel(converted.blocks, converted.firstLevelBlockIds);

      if (sorted.length > 0) {
        await insertBlocksOneByOne(client, docToken, sorted, cellId);
      }

      written++;
    }
  }

  return {
    success: true,
    table_block_id: tableBlockId,
    cells_written: written,
    table_size: { rows, cols },
  };
}

async function createTableWithValues(
  client: Lark.Client,
  docToken: string,
  rowSize: number,
  columnSize: number,
  values: string[][],
) {
  const created = await createTable(client, docToken, rowSize, columnSize);

  const tableBlockId = created.table_block_id;
  if (!tableBlockId) {
    throw new Error('create_table succeeded but table_block_id is missing');
  }

  const written = await writeTableCells(client, docToken, tableBlockId, values);
  return {
    success: true,
    table_block_id: tableBlockId,
    row_size: rowSize,
    column_size: columnSize,
    cells_written: written.cells_written,
  };
}

// ── Tool Registration ───────────────────────────────────────────────────────

export function registerDocTool(server: McpServer, client: Lark.Client): void {
  server.tool(
    'feishu_doc',
    'Feishu document operations. Actions: read, write, append, create, list_blocks, get_block, update_block, delete_block, create_table, write_table_cells, create_table_with_values, upload_image',
    {
      action: z
        .enum([
          'read',
          'write',
          'append',
          'create',
          'list_blocks',
          'get_block',
          'update_block',
          'delete_block',
          'create_table',
          'write_table_cells',
          'create_table_with_values',
          'upload_image',
        ])
        .describe('The action to perform'),
      document_id: z
        .string()
        .optional()
        .describe('Document token or Feishu URL (auto-extracts token from /docx/TOKEN)'),
      content: z
        .string()
        .optional()
        .describe('Markdown content (for write, append, update_block actions)'),
      title: z.string().optional().describe('Document title (for create action)'),
      folder_token: z.string().optional().describe('Target folder token (for create action)'),
      block_id: z
        .string()
        .optional()
        .describe('Block ID (for get_block, update_block, delete_block actions)'),
      rows: z.number().optional().describe('Number of rows (for create_table actions)'),
      columns: z.number().optional().describe('Number of columns (for create_table actions)'),
      table_id: z
        .string()
        .optional()
        .describe('Table block ID (for write_table_cells action)'),
      values: z
        .array(z.array(z.string()))
        .optional()
        .describe('2D array of cell values (for write_table_cells, create_table_with_values)'),
      image_url: z.string().optional().describe('Remote image URL (for upload_image action)'),
    },
    async (params) => {
      try {
        const docToken = params.document_id ? extractDocumentToken(params.document_id) : undefined;

        switch (params.action) {
          case 'read': {
            if (!docToken) throw new Error('document_id is required for read action');
            return json(await readDoc(client, docToken));
          }

          case 'write': {
            if (!docToken) throw new Error('document_id is required for write action');
            if (!params.content) throw new Error('content is required for write action');
            return json(await writeDoc(client, docToken, params.content));
          }

          case 'append': {
            if (!docToken) throw new Error('document_id is required for append action');
            if (!params.content) throw new Error('content is required for append action');
            return json(await appendDoc(client, docToken, params.content));
          }

          case 'create': {
            if (!params.title) throw new Error('title is required for create action');
            return json(await createDoc(client, params.title, params.folder_token));
          }

          case 'list_blocks': {
            if (!docToken) throw new Error('document_id is required for list_blocks action');
            return json(await listBlocks(client, docToken));
          }

          case 'get_block': {
            if (!docToken) throw new Error('document_id is required for get_block action');
            if (!params.block_id) throw new Error('block_id is required for get_block action');
            return json(await getBlock(client, docToken, params.block_id));
          }

          case 'update_block': {
            if (!docToken) throw new Error('document_id is required for update_block action');
            if (!params.block_id) throw new Error('block_id is required for update_block action');
            if (!params.content) throw new Error('content is required for update_block action');
            return json(await updateBlock(client, docToken, params.block_id, params.content));
          }

          case 'delete_block': {
            if (!docToken) throw new Error('document_id is required for delete_block action');
            if (!params.block_id) throw new Error('block_id is required for delete_block action');
            return json(await deleteBlock(client, docToken, params.block_id));
          }

          case 'create_table': {
            if (!docToken) throw new Error('document_id is required for create_table action');
            if (!params.rows || !params.columns)
              throw new Error('rows and columns are required for create_table action');
            return json(await createTable(client, docToken, params.rows, params.columns));
          }

          case 'write_table_cells': {
            if (!docToken) throw new Error('document_id is required for write_table_cells action');
            if (!params.table_id)
              throw new Error('table_id is required for write_table_cells action');
            if (!params.values) throw new Error('values is required for write_table_cells action');
            return json(await writeTableCells(client, docToken, params.table_id, params.values));
          }

          case 'create_table_with_values': {
            if (!docToken)
              throw new Error('document_id is required for create_table_with_values action');
            if (!params.rows || !params.columns)
              throw new Error('rows and columns are required for create_table_with_values action');
            if (!params.values)
              throw new Error('values is required for create_table_with_values action');
            return json(
              await createTableWithValues(
                client,
                docToken,
                params.rows,
                params.columns,
                params.values,
              ),
            );
          }

          case 'upload_image': {
            // Simplified placeholder - image upload requires complex media API orchestration
            return json({
              error:
                'upload_image is not yet fully implemented. To add images to a Feishu document, use the Feishu web editor or the write/append actions with markdown image syntax (images will be rendered as placeholders).',
              hint: 'You can use write or append with markdown containing ![alt](url) to reference images.',
            });
          }

          default:
            return json({ error: `Unknown action: ${params.action}` });
        }
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
