import type { z } from 'zod/v4';

// The input of one tool: zod schemas keyed by argument name.
type CloudbotShape = Readonly<Record<string, z.core.$ZodType>>;

type CloudbotInput<Shape extends CloudbotShape> = { [Key in keyof Shape]: z.core.output<Shape[Key]> };

type CloudbotContent = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };

interface CloudbotToolResult {
    content: CloudbotContent[];
    isError?: boolean | undefined;
}

// Declared as a method so the arguments of a specific tool still fit the list of all tools. The property type keeps
// the handler usable as a plain function.
interface CloudbotHandlers<Shape extends CloudbotShape> {
    handle(args: CloudbotInput<Shape>, extra: unknown): Promise<CloudbotToolResult>;
}

// One tool of the bot's own MCP server. The loopback server serves it to the CLI.
interface CloudbotTool<Shape extends CloudbotShape = CloudbotShape> {
    name: string;
    description: string;
    inputSchema: Shape;
    handler: CloudbotHandlers<Shape>['handle'];
}

function tool<Shape extends CloudbotShape>(
    name: string,
    description: string,
    inputSchema: Shape,
    handler: (args: CloudbotInput<Shape>, extra: unknown) => Promise<CloudbotToolResult>,
): CloudbotTool<Shape> {
    return { name, description, inputSchema, handler };
}

export { tool };
export type { CloudbotContent, CloudbotInput, CloudbotShape, CloudbotTool, CloudbotToolResult };
