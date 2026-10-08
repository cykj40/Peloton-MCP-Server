import type { RegionId } from './muscleRegions.js';

/** Original C3 geometry. Each path is the right half, mirrored by the renderer. */
export type BodyView = 'front' | 'back';
export const HEAD = { cx: 100, cy: 27, rx: 14, ry: 19 } as const;
export const NECK_PATH = 'M 92 42 L 108 42 L 111 56 L 89 56 Z';
export const BASE_PATH = 'M 100 50 L 108 48 C 112 54 124 58 138 62 C 154 62 162 72 162 88 C 164 100 167 112 168 124 C 170 136 169 146 166 152 C 172 158 176 172 180 190 C 182 200 182 210 182 218 C 188 228 189 242 184 254 C 178 258 171 252 169 240 L 168 222 C 162 204 156 186 152 168 C 150 158 148 140 146 122 L 144 112 C 140 128 134 142 132 156 C 132 170 138 188 142 206 C 146 232 146 260 140 282 C 136 296 134 302 134 310 C 140 326 140 346 136 362 C 132 376 128 388 126 398 C 130 410 134 418 134 426 L 112 426 C 112 414 114 404 114 396 C 110 380 106 360 106 340 C 106 326 108 316 110 306 C 106 296 104 282 104 266 C 102 250 102 232 102 216 L 100 216 Z';
const DELT = 'M 138 66 C 148 62 158 68 160 82 C 161 94 158 104 152 110 C 148 100 142 88 136 78 C 134 72 135 68 138 66 Z';
const FOREARM = 'M 156 155 C 162 153 168 155 170 160 C 176 176 180 196 180 216 L 170 220 C 166 200 160 180 156 165 Z';
export interface BodyPiece { view: BodyView; regionId: RegionId; id: string; d: string }
export const PIECES: readonly BodyPiece[] = [
  { view: 'front', regionId: 'upper_back', id: 'trapF', d: 'M 108 50 C 116 56 128 60 140 64 L 134 69 C 124 67 114 63 106 58 Z' },
  { view: 'front', regionId: 'shoulders', id: 'delt', d: DELT },
  { view: 'front', regionId: 'chest', id: 'pec', d: 'M 102 68 C 112 64 126 66 135 72 C 141 82 145 92 147 100 C 139 108 126 114 112 114 C 106 113 102 110 102 104 Z' },
  { view: 'front', regionId: 'biceps', id: 'bicep', d: 'M 150 110 C 156 107 162 112 164 122 C 166 134 166 144 162 152 C 158 150 154 146 152 140 C 148 128 147 118 150 110 Z' },
  { view: 'front', regionId: 'forearms', id: 'fore', d: FOREARM },
  // The supplied ab1 prefix was clipped; restore the top row to match ab2/ab3.
  { view: 'front', regionId: 'core', id: 'ab1', d: 'M 102 118 L 118 116 C 119 122 119 128 118 132 L 102 133 Z' },
  { view: 'front', regionId: 'core', id: 'ab2', d: 'M 102 136 L 118 135 C 119 141 119 146 118 150 L 102 151 Z' },
  { view: 'front', regionId: 'core', id: 'ab3', d: 'M 102 154 L 118 153 C 119 159 118 164 117 168 L 102 169 Z' },
  { view: 'front', regionId: 'core', id: 'ab4', d: 'M 102 172 L 115 171 C 114 182 109 192 102 199 Z' },
  { view: 'front', regionId: 'core', id: 'obl', d: 'M 121 116 C 128 114 135 112 141 110 C 139 124 134 136 131 150 C 130 160 129 168 128 172 C 124 172 121 170 120 166 C 121 150 122 134 121 116 Z' },
  { view: 'front', regionId: 'hips', id: 'hipF', d: 'M 118 174 C 122 178 127 177 130 175 C 135 184 139 195 140 206 C 132 207 124 210 117 213 C 113 209 108 205 105 202 C 111 194 115 184 118 174 Z' },
  { view: 'front', regionId: 'hips', id: 'add', d: 'M 104 207 C 109 211 115 214 121 216 C 115 230 112 248 111 262 C 106 250 103 230 104 207 Z' },
  { view: 'front', regionId: 'quads', id: 'vl', d: 'M 141 211 C 145 230 145 256 141 278 C 139 290 135 298 131 302 C 133 284 133 262 131 240 C 131 226 135 216 141 211 Z' },
  { view: 'front', regionId: 'quads', id: 'rf', d: 'M 128 215 C 133 223 131 250 129 268 C 128 282 126 294 122 300 C 118 294 115 280 114 264 C 113 244 118 222 128 215 Z' },
  // The vm prefix was clipped; its surviving curve starts at the inner quad tip.
  { view: 'front', regionId: 'quads', id: 'vm', d: 'M 113 270 C 115 283 118 294 120 302 C 114 304 109 300 108 292 C 107 284 109 275 113 270 Z' },
  { view: 'front', regionId: 'calves', id: 'calfOF', d: 'M 130 310 C 136 321 138 340 134 356 C 132 366 128 372 126 378 C 126 360 126 336 128 314 Z' },
  { view: 'front', regionId: 'calves', id: 'shin', d: 'M 118 312 C 124 316 126 330 125 350 C 124 366 122 380 120 392 C 118 376 117 352 117 330 Z' },
  { view: 'front', regionId: 'calves', id: 'calfIF', d: 'M 113 310 C 109 326 109 344 112 360 C 114 352 115 336 115 316 Z' },
  { view: 'back', regionId: 'upper_back', id: 'trapB', d: 'M 100 44 C 106 50 116 56 130 60 C 140 63 146 66 146 71 C 134 75 122 81 113 92 C 107 104 103 114 100 124 Z' },
  { view: 'back', regionId: 'shoulders', id: 'deltB', d: DELT },
  { view: 'back', regionId: 'upper_back', id: 'infra', d: 'M 117 92 C 124 82 134 76 145 77 C 146 88 143 98 138 105 C 130 106 122 102 117 97 Z' },
  { view: 'back', regionId: 'upper_back', id: 'lat', d: 'M 110 106 C 120 104 132 106 140 110 C 141 122 138 135 134 148 C 130 160 126 168 120 174 C 114 170 110 164 110 156 Z' },
  { view: 'back', regionId: 'lower_back', id: 'erec', d: 'M 101 122 C 104 123 107 125 108 129 L 108 162 C 111 168 115 173 118 177 C 112 182 106 185 101 186 Z' },
  { view: 'back', regionId: 'core', id: 'oblB', d: 'M 136 152 C 136 165 132 176 128 184 L 121 162 136 152 Z' },
  { view: 'back', regionId: 'hips', id: 'gmed', d: 'M 121 181 C 129 182 135 186 139 195 C 131 190 123 188 112 188 C 115 185 118 183 121 181 Z' },
  { view: 'back', regionId: 'glutes', id: 'glute', d: 'M 101 191 C 112 186 128 186 137 196 C 142 207 140 220 131 228 C 120 232 108 228 101 222 Z' },
  { view: 'back', regionId: 'hamstrings', id: 'hamO', d: 'M 121 234 C 130 232 138 236 141 244 C 142 262 138 282 132 298 L 124 296 C 124 276 123 254 121 234 Z' },
  { view: 'back', regionId: 'hamstrings', id: 'hamI', d: 'M 104 230 C 110 234 115 236 118 240 C 119 260 120 280 120 298 L 112 296 C 108 278 104 254 104 230 Z' },
  { view: 'back', regionId: 'calves', id: 'gasL', d: 'M 120 308 C 128 306 136 314 137 332 C 138 346 134 358 126 364 C 122 350 120 330 120 308 Z' },
  { view: 'back', regionId: 'calves', id: 'gasM', d: 'M 117 308 C 117 330 116 350 114 362 C 108 352 106 336 107 322 C 108 314 112 308 117 308 Z' },
  { view: 'back', regionId: 'calves', id: 'sol', d: 'M 114 367 C 118 371 124 371 128 367 C 128 380 124 392 122 400 L 116 400 C 116 390 114 378 114 367 Z' },
  { view: 'back', regionId: 'triceps', id: 'tri', d: 'M 150 108 C 156 106 162 108 165 114 C 168 127 168 140 165 152 C 160 150 155 146 153 140 C 150 128 148 117 150 108 Z' },
  { view: 'back', regionId: 'forearms', id: 'foreB', d: FOREARM },
];
export interface LabelAnchor { view: BodyView; regionId: RegionId; x: number; y: number }
export const LABEL_ANCHORS: readonly LabelAnchor[] = [
  { view: 'front', regionId: 'shoulders', x: 151, y: 86 },
  { view: 'front', regionId: 'chest', x: 123, y: 93 },
  { view: 'front', regionId: 'biceps', x: 157, y: 131 },
  { view: 'front', regionId: 'forearms', x: 170, y: 192 },
  { view: 'front', regionId: 'core', x: 110, y: 145 },
  { view: 'front', regionId: 'hips', x: 125, y: 197 },
  { view: 'front', regionId: 'quads', x: 129, y: 258 },
  { view: 'front', regionId: 'calves', x: 127, y: 340 },
  { view: 'back', regionId: 'shoulders', x: 151, y: 86 },
  { view: 'back', regionId: 'upper_back', x: 125, y: 128 },
  { view: 'back', regionId: 'lower_back', x: 100, y: 156 },
  { view: 'back', regionId: 'triceps', x: 159, y: 130 },
  { view: 'back', regionId: 'forearms', x: 170, y: 192 },
  { view: 'back', regionId: 'glutes', x: 120, y: 210 },
  { view: 'back', regionId: 'hamstrings', x: 124, y: 268 },
  { view: 'back', regionId: 'calves', x: 126, y: 336 },
];
