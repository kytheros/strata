#!/usr/bin/env node
/**
 * Query helper for the Understand-Anything knowledge graph at
 * `.understand-anything/knowledge-graph.json`.
 *
 * Designed for agent shell-out: agents (or humans) run one of four
 * commands and get a small focused result instead of loading the full
 * 996 KB graph into context.
 *
 * Commands:
 *   summarize <filePath>    — Print summary, layer, tags for a file
 *   layer <layer-name>      — List nodes in a named architectural layer
 *   tests-for <filePath>    — List tests that cover this file (tested_by edges)
 *   dependents <filePath>   — List files that depend on this file (reverse calls/imports/depends_on)
 *
 * Path matching is case-insensitive and accepts substring matches when
 * an exact path isn't found — surfaces "did you mean" suggestions.
 *
 * Exit codes: 0 ok, 1 not-found, 2 missing-graph, 3 bad-args.
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const GRAPH_PATH = resolve(process.cwd(), '.understand-anything/knowledge-graph.json');

function loadGraph() {
  if (!existsSync(GRAPH_PATH)) {
    console.error(`error: knowledge graph not found at ${GRAPH_PATH}`);
    console.error('       run /understand in Claude Code, or invoke the U-A pipeline directly.');
    process.exit(2);
  }
  return JSON.parse(readFileSync(GRAPH_PATH, 'utf-8'));
}

function findNode(graph, query) {
  // Exact filePath match (case-insensitive)
  const q = query.toLowerCase();
  let hit = graph.nodes.find((n) => n.filePath?.toLowerCase() === q);
  if (hit) return { node: hit, exact: true };
  // Exact id match
  hit = graph.nodes.find((n) => n.id.toLowerCase() === q);
  if (hit) return { node: hit, exact: true };
  // Substring filePath match
  const candidates = graph.nodes.filter((n) => n.filePath?.toLowerCase().includes(q));
  if (candidates.length === 1) return { node: candidates[0], exact: false };
  if (candidates.length > 1) return { matches: candidates };
  return null;
}

function layerOf(graph, nodeId) {
  if (!Array.isArray(graph.layers)) return null;
  for (const l of graph.layers) {
    if (Array.isArray(l.nodeIds) && l.nodeIds.includes(nodeId)) return l.name || l.id;
  }
  return null;
}

function cmdSummarize(graph, args) {
  const [target] = args;
  if (!target) { console.error('usage: summarize <filePath>'); process.exit(3); }
  const result = findNode(graph, target);
  if (!result) { console.error(`no node matches "${target}"`); process.exit(1); }
  if (result.matches) {
    console.error(`${result.matches.length} ambiguous matches for "${target}":`);
    for (const m of result.matches.slice(0, 10)) console.error(`  ${m.filePath}`);
    process.exit(1);
  }
  const n = result.node;
  console.log(`File:       ${n.filePath}`);
  console.log(`Type:       ${n.type}`);
  console.log(`Complexity: ${n.complexity || '(unset)'}`);
  console.log(`Layer:      ${layerOf(graph, n.id) || '(unassigned)'}`);
  console.log(`Tags:       ${(n.tags || []).join(', ') || '(none)'}`);
  console.log(`Summary:    ${n.summary || '(no summary)'}`);
  if (n.languageNotes) console.log(`Notes:      ${n.languageNotes}`);
  if (!result.exact) console.log(`\n(matched via substring; exact filePath would be more reliable)`);
}

function cmdLayer(graph, args) {
  const [target] = args;
  if (!target) {
    if (!Array.isArray(graph.layers)) { console.error('graph has no layers'); process.exit(1); }
    console.log('Available layers:');
    for (const l of graph.layers) {
      console.log(`  ${(l.name || l.id).padEnd(36)} (${l.nodeIds?.length || 0} nodes)`);
    }
    return;
  }
  if (!Array.isArray(graph.layers)) { console.error('graph has no layers'); process.exit(1); }
  const q = target.toLowerCase();
  const layer = graph.layers.find((l) => (l.name || l.id || '').toLowerCase().includes(q));
  if (!layer) {
    console.error(`no layer matches "${target}"`);
    console.error('available:');
    for (const l of graph.layers) console.error(`  ${l.name || l.id}`);
    process.exit(1);
  }
  console.log(`Layer: ${layer.name || layer.id}`);
  console.log(`Nodes: ${layer.nodeIds.length}`);
  if (layer.description) console.log(`Description: ${layer.description}`);
  console.log('');
  const nodeById = new Map(graph.nodes.map((n) => [n.id, n]));
  for (const id of layer.nodeIds) {
    const n = nodeById.get(id);
    if (!n) continue;
    const fp = n.filePath || n.id;
    const sum = (n.summary || '').slice(0, 120);
    console.log(`  ${fp}`);
    if (sum) console.log(`    ${sum}`);
  }
}

function cmdTestsFor(graph, args) {
  const [target] = args;
  if (!target) { console.error('usage: tests-for <filePath>'); process.exit(3); }
  const result = findNode(graph, target);
  if (!result || result.matches) {
    console.error(`no single node matches "${target}"`);
    process.exit(1);
  }
  const nodeId = result.node.id;
  const tests = graph.edges
    .filter((e) => e.type === 'tested_by' && e.source === nodeId)
    .map((e) => graph.nodes.find((n) => n.id === e.target))
    .filter(Boolean);
  if (tests.length === 0) {
    console.log(`No tested_by edges from ${result.node.filePath}.`);
    console.log('(absence is informational only — the graph may be incomplete or tests may exist that weren\'t linked)');
    return;
  }
  console.log(`Tests covering ${result.node.filePath}:`);
  for (const t of tests) console.log(`  ${t.filePath || t.id}`);
}

function cmdDependents(graph, args) {
  const [target] = args;
  if (!target) { console.error('usage: dependents <filePath>'); process.exit(3); }
  const result = findNode(graph, target);
  if (!result || result.matches) {
    console.error(`no single node matches "${target}"`);
    process.exit(1);
  }
  const nodeId = result.node.id;
  const DEPS = new Set(['calls', 'imports', 'depends_on']);
  const dependents = graph.edges
    .filter((e) => DEPS.has(e.type) && e.target === nodeId)
    .map((e) => ({ src: graph.nodes.find((n) => n.id === e.source), type: e.type }))
    .filter((x) => x.src);
  if (dependents.length === 0) {
    console.log(`No dependents found for ${result.node.filePath}.`);
    console.log('(may be a leaf module, or the graph missed inbound edges)');
    return;
  }
  console.log(`Files depending on ${result.node.filePath}:`);
  for (const d of dependents) {
    console.log(`  [${d.type.padEnd(11)}] ${d.src.filePath || d.src.id}`);
  }
}

const [, , cmd, ...rest] = process.argv;

if (!cmd || cmd === 'help' || cmd === '-h' || cmd === '--help') {
  console.log('Usage: node scripts/query-graph.mjs <command> [args]');
  console.log('');
  console.log('Commands:');
  console.log('  summarize <filePath>      Summary + layer + tags + LLM notes for a file');
  console.log('  layer [name]              List nodes in a layer (or all layers if no name)');
  console.log('  tests-for <filePath>      Tests linked to this file via tested_by edges');
  console.log('  dependents <filePath>     Files that depend on this one (reverse calls/imports/depends_on)');
  console.log('');
  console.log('Knowledge graph path: ' + GRAPH_PATH);
  process.exit(cmd ? 0 : 3);
}

const graph = loadGraph();

const handlers = {
  summarize: cmdSummarize,
  layer: cmdLayer,
  'tests-for': cmdTestsFor,
  dependents: cmdDependents,
};

const handler = handlers[cmd];
if (!handler) {
  console.error(`unknown command: ${cmd}`);
  console.error('run `node scripts/query-graph.mjs help` for usage');
  process.exit(3);
}

handler(graph, rest);
