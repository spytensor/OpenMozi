/**
 * Lightweight complexity detection for suggesting DAG decomposition.
 * Does NOT make the decision — only provides a hint to the Brain.
 */

/**
 * Explicit multi-phase / multi-step structure markers. A prompt that is
 * ORGANIZED into phases ("阶段一/二/三", "Phase 1/2", "Step 1:", "步骤二")
 * is the single strongest decomposition signal there is — a real production
 * failure shipped exactly this shape and the old signal list missed it
 * entirely (only "三个区域" matched, one signal, below threshold).
 */
const PHASE_MARKER = /(?:^|[\n*#>\s])(?:阶段|步骤|第\s*[一二三四五六七八九十\d]+\s*(?:阶段|步|部分|环节)|phase\s*\d|stage\s*\d|step\s*\d)/gim;

export function shouldSuggestDecomposition(userMessage: string): boolean {
  const text = typeof userMessage === 'string' ? userMessage : '';
  // CJK characters carry more information per char; use a lower threshold
  const hasCjk = /[㐀-鿿]/.test(text);
  if (text.length < (hasCjk ? 10 : 30)) return false;

  // Two or more explicit phase/step markers = the user already decomposed
  // the task for us. No further evidence needed.
  const phaseMarkers = text.match(PHASE_MARKER);
  if (phaseMarkers && phaseMarkers.length >= 2) return true;

  const signals = [
    /compar|对比|比较|versus|vs\b/i.test(text),
    /and then.*and then|然后.*然后|同时.*同时/i.test(text),
    /(?:\b(\d+)|[一二三四五六七八九十]+)\s*(个|项|steps?|things?|products?|competitors?|files?)/i.test(text),
    /research.*report|调研.*报告|分析.*总结|investigate.*summarize|analyze.*summarize/i.test(text),
    /多个|multiple|several|各个|respectively|for each|each\b.*separately|separately\b.*each/i.test(text),
    // Deliverable-with-acceptance language: staged work heading for review
    /交付|验收|评审|deliverable|acceptance criteria|final report/i.test(text),
  ];
  return signals.filter(Boolean).length >= 2;
}
