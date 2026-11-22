/**
 * "AI report" for the dashboard: what works, what does not, why, what to test next, and how sure we are.
 * It is RULE-BASED on the owner's own measured data (learn.ts insights, channel DNA, experiments). No language model is called, so nothing here is invented:
 * every line comes from a stored number, and with too little data the report says NO EVIDENCE YET instead of guessing.
 */
import type { Store } from '../db.ts';
import { learningReport, MIN_TOTAL } from './learn.ts';
import { channelDnaFor } from './dna.ts';
import { listExperiments } from './experiments.ts';
export interface Report { generatedBy: 'rules (no AI model)'; status: 'NO EVIDENCE YET' | 'OK'; observations: number; working: string[]; notWorking: string[]; reasons: string[]; nextExperiments: string[]; openExperiments: number; confidence: 'none' | 'low' | 'medium' | 'high'; note: string }
export function buildReport(store: Store, now = Date.now()): Report {
  const { analysis } = learningReport(store, now); const dna = channelDnaFor(store, null, now); const open = listExperiments(store).filter((e) => e.status === 'open').length;
  if (analysis.status !== 'ok') return { generatedBy: 'rules (no AI model)', status: 'NO EVIDENCE YET', observations: analysis.observations, working: [], notWorking: [], reasons: [analysis.reason ?? 'not enough judged clips'], nextExperiments: ['Import the YouTube Studio CSV (or publish more clips) until at least ' + MIN_TOTAL + ' clips are judged'], openExperiments: open, confidence: 'none', note: 'no claim is made without data' };
  const working = analysis.insights.filter((i) => i.kind === 'strength').map((i) => `${i.dimension} "${i.bucket}": ${i.lift}x the median (n=${i.n}, ${i.confidence})`);
  const notWorking = analysis.insights.filter((i) => i.kind === 'weakness').map((i) => `${i.dimension} "${i.bucket}": ${i.lift}x the median (n=${i.n}, ${i.confidence})`);
  const reasons = [...analysis.insights.map((i) => i.hypothesis), ...(dna.recommendation !== 'NO EVIDENCE YET' ? [`channel DNA: ${dna.recommendation} - ${dna.reason}`] : [])];
  const next = [...analysis.insights.filter((i) => i.kind === 'strength').map((i) => `Make 5 more clips with ${i.dimension} "${i.bucket}" and compare (create an experiment)`), ...analysis.insights.filter((i) => i.kind === 'weakness').map((i) => `Change one thing in ${i.dimension} "${i.bucket}" clips (hook or length) and compare`)];
  const rank = { low: 1, medium: 2, high: 3 } as const; const best = analysis.insights.reduce((m, i) => Math.max(m, rank[i.confidence]), 0);
  return { generatedBy: 'rules (no AI model)', status: 'OK', observations: analysis.observations, working, notWorking, reasons, nextExperiments: next.length ? next : ['No clear winner or loser yet: keep posting and re-check'], openExperiments: open, confidence: best === 3 ? 'high' : best === 2 ? 'medium' : 'low', note: 'hypotheses from measured data, not proven causes' };
}
