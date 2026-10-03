/**
 * Advance widths (in em) of DejaVu Sans for printable ASCII (U+0020..U+007E), used to size chart
 * labels. Measured with resvg's getBBox at font-size 100 inside the production image
 * (node:20-alpine + font-dejavu) by comparing "|c|" against "||". Kerning is ignored, which can only
 * overstate a width, so estimates stay conservative.
 */

const FIRST_CODE = 0x20;

const REGULAR_ADVANCE_EM: readonly number[] = [
  0.318, 0.401, 0.460, 0.838, 0.636, 0.950, 0.780, 0.275, 0.390, 0.390,
  0.500, 0.838, 0.318, 0.361, 0.318, 0.337, 0.636, 0.636, 0.636, 0.636,
  0.636, 0.636, 0.636, 0.636, 0.636, 0.636, 0.337, 0.337, 0.838, 0.838,
  0.838, 0.531, 1.000, 0.684, 0.686, 0.698, 0.770, 0.632, 0.575, 0.775,
  0.752, 0.295, 0.295, 0.656, 0.557, 0.863, 0.748, 0.787, 0.603, 0.787,
  0.695, 0.635, 0.611, 0.732, 0.684, 0.989, 0.685, 0.611, 0.685, 0.390,
  0.337, 0.390, 0.838, 0.500, 0.500, 0.613, 0.635, 0.550, 0.635, 0.615,
  0.352, 0.635, 0.634, 0.278, 0.278, 0.579, 0.278, 0.974, 0.634, 0.612,
  0.635, 0.635, 0.411, 0.521, 0.392, 0.634, 0.592, 0.818, 0.592, 0.592,
  0.525, 0.636, 0.337, 0.636, 0.838,
];

const BOLD_ADVANCE_EM: readonly number[] = [
  0.348, 0.456, 0.521, 0.838, 0.696, 1.002, 0.872, 0.306, 0.457, 0.457,
  0.523, 0.838, 0.380, 0.415, 0.380, 0.365, 0.696, 0.696, 0.696, 0.696,
  0.696, 0.696, 0.696, 0.696, 0.696, 0.696, 0.400, 0.400, 0.838, 0.838,
  0.838, 0.580, 1.000, 0.774, 0.762, 0.734, 0.830, 0.683, 0.683, 0.821,
  0.837, 0.372, 0.372, 0.775, 0.637, 0.995, 0.837, 0.850, 0.733, 0.850,
  0.770, 0.720, 0.682, 0.812, 0.774, 1.103, 0.771, 0.724, 0.725, 0.457,
  0.365, 0.457, 0.838, 0.500, 0.500, 0.675, 0.716, 0.593, 0.716, 0.678,
  0.435, 0.716, 0.712, 0.343, 0.343, 0.665, 0.343, 1.042, 0.712, 0.687,
  0.716, 0.716, 0.493, 0.595, 0.478, 0.712, 0.652, 0.924, 0.645, 0.652,
  0.582, 0.712, 0.365, 0.712, 0.838,
];

/** Width used for characters outside the table; deliberately wide. */
const FALLBACK_ADVANCE_EM = 1;

export function advanceEm(char: string, bold: boolean): number {
  const table = bold ? BOLD_ADVANCE_EM : REGULAR_ADVANCE_EM;
  return table[char.charCodeAt(0) - FIRST_CODE] ?? FALLBACK_ADVANCE_EM;
}
