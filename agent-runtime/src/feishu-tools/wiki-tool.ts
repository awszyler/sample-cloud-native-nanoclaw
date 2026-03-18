/**
 * ClawBot Cloud — Feishu Wiki MCP Tool
 *
 * Registers the `feishu_wiki` MCP tool for interacting with Feishu/Lark
 * knowledge base (wiki) spaces and nodes.
 * Uses the Lark SDK (@larksuiteoapi/node-sdk) for all API operations.
 *
 * Actions: spaces, nodes, get, create, move, rename
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

const WIKI_ACCESS_HINT =
  'To grant wiki access: Open wiki space settings and add the bot as a member. ' +
  'See: https://open.feishu.cn/document/server-docs/docs/wiki-v2/wiki-qa#a40ad4ca';

// ── Core Functions ──────────────────────────────────────────────────────────

async function listSpaces(client: Lark.Client) {
  const res = await client.wiki.space.list({});
  if (res.code !== 0) {
    throw new Error(res.msg);
  }

  const spaces =
    res.data?.items?.map((s) => ({
      space_id: s.space_id,
      name: s.name,
      description: s.description,
      visibility: s.visibility,
    })) ?? [];

  return {
    spaces,
    ...(spaces.length === 0 && { hint: WIKI_ACCESS_HINT }),
  };
}

async function listNodes(client: Lark.Client, spaceId: string, parentNodeToken?: string) {
  const res = await client.wiki.spaceNode.list({
    path: { space_id: spaceId },
    params: { parent_node_token: parentNodeToken },
  });
  if (res.code !== 0) {
    throw new Error(res.msg);
  }

  return {
    nodes:
      res.data?.items?.map((n) => ({
        node_token: n.node_token,
        obj_token: n.obj_token,
        obj_type: n.obj_type,
        title: n.title,
        has_child: n.has_child,
      })) ?? [],
  };
}

async function getNode(client: Lark.Client, token: string) {
  const res = await client.wiki.space.getNode({
    params: { token },
  });
  if (res.code !== 0) {
    throw new Error(res.msg);
  }

  const node = res.data?.node;
  return {
    node_token: node?.node_token,
    space_id: node?.space_id,
    obj_token: node?.obj_token,
    obj_type: node?.obj_type,
    title: node?.title,
    parent_node_token: node?.parent_node_token,
    has_child: node?.has_child,
    creator: node?.creator,
    create_time: node?.node_create_time,
    hint: node?.obj_type === 'docx'
      ? `Use feishu_doc with document_id: "${node?.obj_token}" to read or edit this document.`
      : undefined,
  };
}

async function createNode(
  client: Lark.Client,
  spaceId: string,
  title: string,
  objType?: string,
  parentNodeToken?: string,
) {
  type ObjType = 'doc' | 'sheet' | 'mindnote' | 'bitable' | 'file' | 'docx' | 'slides';

  const res = await client.wiki.spaceNode.create({
    path: { space_id: spaceId },
    data: {
      obj_type: (objType as ObjType) || 'docx',
      node_type: 'origin' as const,
      title,
      parent_node_token: parentNodeToken,
    },
  });
  if (res.code !== 0) {
    throw new Error(res.msg);
  }

  const node = res.data?.node;
  return {
    node_token: node?.node_token,
    obj_token: node?.obj_token,
    obj_type: node?.obj_type,
    title: node?.title,
  };
}

async function moveNode(
  client: Lark.Client,
  spaceId: string,
  nodeToken: string,
  targetSpaceId?: string,
  targetParentToken?: string,
) {
  const res = await client.wiki.spaceNode.move({
    path: { space_id: spaceId, node_token: nodeToken },
    data: {
      target_space_id: targetSpaceId || spaceId,
      target_parent_token: targetParentToken,
    },
  });
  if (res.code !== 0) {
    throw new Error(res.msg);
  }

  return {
    success: true,
    node_token: res.data?.node?.node_token,
  };
}

async function renameNode(client: Lark.Client, spaceId: string, nodeToken: string, title: string) {
  const res = await client.wiki.spaceNode.updateTitle({
    path: { space_id: spaceId, node_token: nodeToken },
    data: { title },
  });
  if (res.code !== 0) {
    throw new Error(res.msg);
  }

  return {
    success: true,
    node_token: nodeToken,
    title,
  };
}

// ── Tool Registration ───────────────────────────────────────────────────────

export function registerWikiTool(server: McpServer, client: Lark.Client): void {
  server.tool(
    'feishu_wiki',
    'Feishu knowledge base (wiki) operations. Actions: spaces (list wiki spaces), nodes (list nodes in a space), get (get node details and obj_token for use with feishu_doc), create (create new wiki node), move (move node to different parent/space), rename (rename a node)',
    {
      action: z
        .enum(['spaces', 'nodes', 'get', 'create', 'move', 'rename'])
        .describe('The action to perform'),
      space_id: z
        .string()
        .optional()
        .describe('Knowledge space ID (required for nodes, create, move, rename)'),
      node_token: z
        .string()
        .optional()
        .describe(
          'Wiki node token (required for get, move, rename). Can be extracted from wiki URL /wiki/TOKEN',
        ),
      parent_node_token: z
        .string()
        .optional()
        .describe('Parent node token (optional for nodes, create)'),
      title: z.string().optional().describe('Node title (required for create, rename)'),
      obj_type: z
        .enum(['docx', 'sheet', 'bitable'])
        .optional()
        .describe('Object type for new nodes (default: docx)'),
      target_space_id: z
        .string()
        .optional()
        .describe('Target space ID for move (defaults to same space)'),
      target_parent_token: z
        .string()
        .optional()
        .describe('Target parent node token for move (defaults to root)'),
    },
    async (params) => {
      try {
        switch (params.action) {
          case 'spaces': {
            return json(await listSpaces(client));
          }

          case 'nodes': {
            if (!params.space_id) throw new Error('space_id is required for nodes action');
            return json(await listNodes(client, params.space_id, params.parent_node_token));
          }

          case 'get': {
            if (!params.node_token) throw new Error('node_token is required for get action');
            return json(await getNode(client, params.node_token));
          }

          case 'create': {
            if (!params.space_id) throw new Error('space_id is required for create action');
            if (!params.title) throw new Error('title is required for create action');
            return json(
              await createNode(
                client,
                params.space_id,
                params.title,
                params.obj_type,
                params.parent_node_token,
              ),
            );
          }

          case 'move': {
            if (!params.space_id) throw new Error('space_id is required for move action');
            if (!params.node_token) throw new Error('node_token is required for move action');
            return json(
              await moveNode(
                client,
                params.space_id,
                params.node_token,
                params.target_space_id,
                params.target_parent_token,
              ),
            );
          }

          case 'rename': {
            if (!params.space_id) throw new Error('space_id is required for rename action');
            if (!params.node_token) throw new Error('node_token is required for rename action');
            if (!params.title) throw new Error('title is required for rename action');
            return json(await renameNode(client, params.space_id, params.node_token, params.title));
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
