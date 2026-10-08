import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import nock from 'nock';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../../index.js';
import { PELOTON_API_URL } from '../../constants.js';
import { PelotonClient } from '../../services/pelotonClient.js';
import { RideMuscleCache } from '../../services/rideMuscleCache.js';
import { saveToken } from '../../services/tokenStore.js';
import { handleMuscleActivityChart } from '../../tools/muscleActivityChart.js';
import { handleAnalyticsTool, analyticsTools } from '../../tools/analytics.js';
import * as chartRenderer from '../../charts/muscleChartRenderer.js';
import { REGIONS } from '../../charts/muscleRegions.js';
import { setupTestDb, teardownTestDb } from '../testDb.js';
import type { MuscleScores } from '../../types/muscleData.js';
import type { ToolResponse } from '../../types/index.js';

const NOW = Date.UTC(2026, 9, 3, 12);
const DAY = 86_400_000;
const rawWorkout = (id: string, age: number, title = '30 min Strength', discipline = 'strength', duration = 1800) => ({
  id, created_at: (NOW - age * DAY) / 1000, fitness_discipline: discipline, status: 'COMPLETE',
  ride: { id: `class-${id}`, title, duration },
});
const textOf = (response: ToolResponse) => response.content.filter(c => c.type === 'text').map(c => c.text).join('\n');
const balanced: MuscleScores = Object.fromEntries(REGIONS.map(region => [region.sourceKeys[0], 10]));

describe('muscle activity chart handler', () => {
  let client: PelotonClient;
  let cache: RideMuscleCache;
  const run = (args: unknown = {}) => handleMuscleActivityChart(args, client, { now: () => NOW, cache });
  const history = (workouts: ReturnType<typeof rawWorkout>[]) => {
    nock(PELOTON_API_URL).get('/api/me').reply(200, { id: 'chart-user', username: 'fixture' });
    nock(PELOTON_API_URL).get('/api/user/chart-user/workouts').query({ limit: 100, page: 0, joins: 'ride,ride.instructor', sort_by: '-created' })
      .reply(200, { data: workouts, total: workouts.length, show_next: false });
  };
  const details = (id: string, scores: MuscleScores) => {
    nock(PELOTON_API_URL).get(`/api/ride/class-${id}/details`).reply(200, {
      ride: { muscle_group_score: Object.entries(scores).map(([muscle_group, score]) => ({ muscle_group, score })) },
    });
  };
  const app = (days = 7, fails = false) => {
    nock(PELOTON_API_URL).get('/api/user/chart-user/workouts').query({
      from: new Date(NOW - days * DAY).toISOString(), to: new Date(NOW).toISOString(),
      stats_from: new Date(NOW - days * DAY).toISOString(), stats_to: new Date(NOW).toISOString(), joins: 'ride',
    }).reply(fails ? 500 : 200, fails ? {} : { muscle_group_score: [
      ['glutes', 7, 45178], ['hamstrings', 7, 45178], ['quads', 7, 45178],
      ['calves', 7, 43378], ['hips', 6, 43378], ['core', 6, 41505],
    ].map(([muscle_group, percentage, score]) => ({ muscle_group, percentage, score, bucket: 1 })) });
  };
  beforeEach(async () => {
    await setupTestDb();
    PelotonClient.clearCache();
    nock.cleanAll();
    const token = 'eyJhbGciOiJSUzI1NiJ9.chart.fixture';
    await saveToken({ access_token: token, token_type: 'Bearer', user_id: 'chart-user', expires_at: Date.now() + 7 * DAY });
    client = new PelotonClient(token);
    cache = new RideMuscleCache(() => NOW);
  });
  afterEach(async () => {
    const pending = nock.pendingMocks();
    nock.cleanAll(); vi.restoreAllMocks(); await teardownTestDb();
    expect(pending).toEqual([]);
  });

  it('returns a real PNG plus all text sections, projections and examples from older personal history', async () => {
    const rendering = vi.spyOn(chartRenderer, 'renderMuscleChartPng');
    history([rawWorkout('recent', 1), rawWorkout('arms', 40, '20 min Arms & Shoulders Strength', 'strength', 1200)]);
    details('recent', { ...balanced, biceps: 0 }); details('arms', { biceps: 10 }); app();
    const result = await run();
    expect(result.isError).not.toBe(true);
    expect(result.content.map(item => item.type)).toEqual(['image', 'text']);
    const image = result.content.find(item => item.type === 'image')!;
    if (image.type !== 'image') throw Error('Missing image');
    expect(image.mimeType).toBe('image/png');
    expect(Buffer.from(image.data, 'base64').subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
    const text = textOf(result);
    for (const expected of ['rolling last 7 days', 'Workouts by discipline: strength 1', '1 of 1 workouts have Peloton muscle data', 'Weighting: raw', "Peloton app shows:", "app's own near-flat aggregate", 'Other 60%', '20 min strength', '20 min Arms & Shoulders Strength', 'Biceps 0.0% →', 'Projected percentages after the plan', 'Projections assume each added session resembles your past classes of that type.', 'scores come from Peloton class data']) expect(text).toContain(expected);
    for (const region of REGIONS) expect(text).toContain(`${region.label}:`);
    expect(text).toContain('Needs attention (<5%)');
    expect(text).not.toMatch(/insulin|glucose|medical advice/i);
    expect(text).not.toContain('class-arms');
    expect(text).not.toContain('current figure has no shapes');
    expect(rendering).toHaveBeenCalledWith(expect.objectContaining({
      sourceInfo: expect.objectContaining({ source: 'peloton_class_data', workoutsWithData: 1, workoutsTotal: 1 }),
      plannerSummary: expect.objectContaining({ sessionLine: expect.stringContaining('20 min'), shiftsLine: expect.stringContaining('Biceps 0 →') }),
    }));
  });

  it.each([{ days: 0 }, { days: 91 }, { days: 1.5 }, { days: '7' }, { weighting: 'invalid' }, { weighting: null }])('validates options without fetching data: %j', async args => {
    const result = await run(args);
    expect(result.isError).toBe(true);
    expect(result.content).toHaveLength(1);
    expect(textOf(result)).toBe('Invalid chart options. Use days 1–90 and weighting raw or per_minute.');
  });

  it('handles an empty window and defaults without inventing workouts or suggestions', async () => {
    history([]); app();
    const result = await run();
    expect(result.content[0]?.type).toBe('image');
    expect(textOf(result)).toContain('No workouts in this rolling window');
    expect(textOf(result)).toContain('0 of 0 workouts have Peloton muscle data');
    expect(textOf(result)).toContain('No suggestions: there are no workouts');
    expect(textOf(result)).toContain('Weighting: raw');
  });

  it('labels estimate fallback and does not mix estimated totals with class-based projections', async () => {
    const rendering = vi.spyOn(chartRenderer, 'renderMuscleChartPng');
    history([rawWorkout('failed', 1)]);
    nock(PELOTON_API_URL).get('/api/ride/class-failed/details').reply(500);
    app();
    const result = await run();
    expect(result.content[0]?.type).toBe('image');
    const text = textOf(result);
    expect(text).toContain('Data source: estimate. 0 of 1 workouts');
    expect(text).toContain('muscle scores are estimated');
    expect(text).toContain('No suggestions: class data is unavailable');
    expect(text).not.toContain('Projected percentages after the plan');
    expect(rendering).toHaveBeenCalledWith(expect.objectContaining({
      sourceInfo: expect.objectContaining({ source: 'estimate', workoutsWithData: 0, workoutsTotal: 1 }),
      plannerSummary: null,
    }));
  });

  it('omits a failed app comparison and still returns the per-minute chart', async () => {
    history([rawWorkout('perminute', 1)]); details('perminute', balanced); app(30, true);
    const result = await run({ days: 30, weighting: 'per_minute' });
    expect(result.content[0]?.type).toBe('image');
    expect(textOf(result)).toContain('rolling last 30 days');
    expect(textOf(result)).toContain("Weighting: per_minute = each class's share of muscles weighted by the minutes you spent.");
    expect(textOf(result)).not.toContain('Peloton app shows:');
  });

  it('limits the workout list to 15 lines including its truncation notice', async () => {
    const workouts = Array.from({ length: 16 }, (_, i) => rawWorkout(`many-${i}`, 1 + i / 100));
    history(workouts); for (let i = 0; i < 16; i++) details(`many-${i}`, balanced); app();
    const result = await run();
    const text = textOf(result);
    const list = text.split('Workouts:\n')[1]!.split('\nData source:')[0]!.split('\n');
    expect(list).toHaveLength(15);
    expect(list[14]).toBe('- 2 more workouts in this window.');
    expect(list[0]).toMatch(/^- 2026-10-02 \| strength \| 30 min Strength \| 30 min$/);
    expect(text).toContain('Workouts by discipline: strength 16');
  });

  it('returns only a short safe error when the required history fetch fails', async () => {
    nock(PELOTON_API_URL).get('/api/me').reply(200, { id: 'chart-user', username: 'fixture' });
    nock(PELOTON_API_URL).get('/api/user/chart-user/workouts').query(true).reply(500, { message: 'private-id secret-token fake-stack' });
    expect(await run()).toEqual({ isError: true, content: [{ type: 'text', text: 'Unable to build the muscle activity chart. Please try again.' }] });
  });

  it('routes chart validation through the analytics dispatcher', async () => {
    const result = await handleAnalyticsTool('peloton_muscle_activity_chart', { days: 0, weighting: 'raw' }, client);
    expect(result.isError).toBe(true);
  });

  it('registers the new tool in the actual MCP server and redirects legacy descriptions', async () => {
    const server = createMcpServer();
    const sdkClient = new Client({ name: 'chart-registration-test', version: '1.0.0' });
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport); await sdkClient.connect(clientTransport);
      const tools = (await sdkClient.listTools()).tools;
      const tool = tools.find(tool => tool.name === 'peloton_muscle_activity_chart');
      expect(tool).toBeDefined();
      expect(tool?.inputSchema.properties).toMatchObject({ days: { type: 'integer', minimum: 1, maximum: 90, default: 7 }, weighting: { enum: ['raw', 'per_minute'], default: 'raw' } });
      for (const phrase of ['what did I do this week/month', 'what should I work out today', 'how balanced was my training', 'which muscles am I neglecting', 'plan me a balanced week', 'raw JSON']) expect(tool?.description).toContain(phrase);
      for (const name of ['peloton_muscle_activity', 'peloton_muscle_impact', 'peloton_training_balance']) expect(analyticsTools.find(tool => tool.name === name)?.description).toContain('peloton_muscle_activity_chart');
    } finally { await sdkClient.close(); await server.close(); }
  });
});
