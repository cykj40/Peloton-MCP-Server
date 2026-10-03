// TEMPORARY (Phase 2 step 1 risk gate): proves MCP image content blocks render in the
// Claude connector. Delete this file and its registration in src/index.ts after the check.
import { ToolResponse } from '../types/index.js';

// 96x48 PNG: three vertical bands (teal / gray / amber), 163 bytes.
const PROBE_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAGAAAAAwCAIAAABhdOiYAAAAaklEQVR4nO3QMQ0AIAwAsClCAJbQgAhk8exEAzJQsYOkSRU02hyldp5Sd/VSIUiQIEGCBAkSJEiQIEGCBAkSJEiQIEGCBAkSJEiQIEGCBAkSJEiQIEGCBAkSJEiQIEGCBAkSJEiQIEF/BD0/E0XSSqE1ywAAAABJRU5ErkJggg==';

export const imageProbeTool = {
  name: 'peloton_image_probe' as const,
  description:
    'TEMPORARY diagnostic. Returns a small test PNG (three colored bands: teal, gray, amber) as an MCP image content block, plus a text line. Call it only to verify image rendering.',
  inputSchema: {
    type: 'object' as const,
    properties: {},
    required: [] as string[],
  },
};

export function handleImageProbe(): ToolResponse {
  return {
    content: [
      { type: 'image', data: PROBE_PNG_BASE64, mimeType: 'image/png' },
      {
        type: 'text',
        text: 'Image probe: if you can see an image of three colored bands (teal, gray, amber) above, image content blocks render.',
      },
    ],
  };
}
