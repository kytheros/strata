// Verifies that examples are registered for every tool the registry
// ships, that the renderer produces the format the model is being
// guided by, and that registering examples is a no-op on the tool's
// underlying input_schema (we ship 1:1 to Anthropic).

import { describe, it, expect } from 'vitest';
import { TOOLS } from '../../app/lib/tools';
import { TOOL_EXAMPLES, withExamples } from '../../app/lib/tools/tool-examples';

describe('tool-examples renderer', () => {
  it('appends an Examples section that cites the tool name and JSON args', () => {
    const rendered = withExamples(
      'list_active_alarms',
      'BASE-DESCRIPTION',
    );
    expect(rendered.startsWith('BASE-DESCRIPTION')).toBe(true);
    expect(rendered).toContain('**Examples**');
    expect(rendered).toContain(
      'list_active_alarms({"stateValue":"ALARM"})',
    );
    expect(rendered).toContain('list_active_alarms({})');
  });

  it('returns the description unchanged when no examples are registered', () => {
    const rendered = withExamples('not_a_real_tool', 'BASE');
    expect(rendered).toBe('BASE');
  });

  it('every shipped tool has at least one registered example', () => {
    for (const tool of TOOLS) {
      const examples = TOOL_EXAMPLES[tool.name];
      expect(examples, `no examples for ${tool.name}`).toBeDefined();
      expect(examples!.length).toBeGreaterThan(0);
    }
  });

  it("every tool's description carries its rendered examples", () => {
    for (const tool of TOOLS) {
      expect(
        tool.description,
        `description missing for ${tool.name}`,
      ).toBeDefined();
      expect(tool.description!).toContain('**Examples**');
      // The first example's tool-name invocation must appear verbatim.
      const firstExample = TOOL_EXAMPLES[tool.name]![0];
      const argsJson =
        firstExample.args === null ? 'null' : JSON.stringify(firstExample.args);
      expect(tool.description!).toContain(`${tool.name}(${argsJson})`);
    }
  });

  it('input_schema on every tool is a JSON Schema object (no top-level input_examples field leaked)', () => {
    for (const tool of TOOLS) {
      expect(tool.input_schema.type).toBe('object');
      // The Anthropic Messages API does not accept input_examples at the
      // tool level — make sure we never let one slip in.
      expect((tool as unknown as Record<string, unknown>).input_examples).toBeUndefined();
    }
  });
});
