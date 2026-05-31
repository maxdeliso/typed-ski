import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseTripLang } from "../parser/tripLang.ts";
import { discoverTripFiles } from "./index.ts";
import { scanTrip, type ScanToken } from "./lexer.ts";
import { workspaceRoot } from "../shared/workspaceRoot.ts";

export interface FormattingToken {
  kind: string;
  text: string;
  start: number;
  end: number;
}

const FORMATTING_KEYWORDS = new Set([
  "module",
  "import",
  "export",
  "opaque",
  "native",
  "type",
  "data",
  "poly",
  "combinator",
  "let",
  "in",
  "match",
  "if",
]);

const FORMATTING_SYMBOLS = new Set([
  "(",
  ")",
  "[",
  "]",
  "{",
  "}",
  ",",
  ":",
  "=",
  "|",
  "#",
  "\\",
]);

function formattingKind(token: ScanToken): string {
  if (token.kind === "ident" && FORMATTING_KEYWORDS.has(token.text)) {
    return token.text;
  }
  if (token.kind === "symbol") {
    return FORMATTING_SYMBOLS.has(token.text) ? token.text : "unknown";
  }
  return token.kind;
}

/**
 * Tokenizer that retains all spaces and newlines for formatting evaluation.
 */
export function tokenizeFormatting(source: string): FormattingToken[] {
  return scanTrip(source, false).map((token) => ({
    kind: formattingKind(token),
    text: token.text,
    start: token.start,
    end: token.end,
  }));
}

/**
 * Maps a FormattingToken to a vocabulary representation string.
 */
export function getVocabRep(token: FormattingToken): string {
  if (token.kind === "space") {
    if (token.text.length === 1) return "<space>";
    return `<spaces:${token.text.length}>`;
  }
  if (token.kind === "newline") return "<newline>";
  if (token.kind === "ident") return "<ident>";
  if (token.kind === "number") return "<number>";
  if (token.kind === "string") return "<string>";
  if (token.kind === "char") return "<char>";
  if (token.kind === "lineComment") return "<lineComment>";
  if (token.kind === "blockComment") return "<blockComment>";
  if (token.kind === "unknown") return "<unknown>";
  return token.kind;
}

/**
 * 8-Gram Kneser-Ney Language Model implementation for unsupervised style learning.
 */
export class KneserNeyLM {
  counts: Map<string, number>[] = [];
  // Precomputed Kneser-Ney statistics, indexed by gram order to match `counts`.
  // contextTotals[k] maps a (k-1)-token prefix to the summed count of k-grams
  // with that prefix — the denominator c(context). followerCounts[k] maps the
  // same prefix to the number of distinct k-grams with it — the continuation
  // count N1+(context.). Both are filled during training so a probability query
  // never has to scan the vocabulary.
  contextTotals: Map<string, number>[] = [];
  followerCounts: Map<string, number>[] = [];
  vocab: Set<string> = new Set();
  uniquePreceders: Map<string, Set<string>> = new Map();
  totalUniqueBigrams = 0;
  maxOrder = 8;
  discount = 0.75;

  constructor(maxOrder = 8) {
    this.maxOrder = maxOrder;
    for (let i = 0; i <= maxOrder; i++) {
      this.counts.push(new Map());
      this.contextTotals.push(new Map());
      this.followerCounts.push(new Map());
    }
  }

  train(tokenSequences: string[][]) {
    for (const seq of tokenSequences) {
      for (const token of seq) {
        this.vocab.add(token);
      }

      for (let order = 1; order <= this.maxOrder; order++) {
        for (let i = 0; i <= seq.length - order; i++) {
          const slice = seq.slice(i, i + order);
          const ngram = slice.join("|");
          const countMap = this.counts[order]!;
          const prevCount = countMap.get(ngram);
          countMap.set(ngram, (prevCount || 0) + 1);

          // Accumulate the context denominator, and — the first time an n-gram
          // is seen — its prefix's distinct-follower count. The prefix is keyed
          // off the token array (not the joined string) so a literal "|" token
          // can't be confused with the "|" join delimiter.
          if (order >= 2) {
            const prefix = slice.slice(0, order - 1).join("|");
            const totals = this.contextTotals[order]!;
            totals.set(prefix, (totals.get(prefix) || 0) + 1);
            if (prevCount === undefined) {
              const followers = this.followerCounts[order]!;
              followers.set(prefix, (followers.get(prefix) || 0) + 1);
            }
          }

          if (order === 2) {
            const w_prev = seq[i]!;
            const w_curr = seq[i + 1]!;
            if (!this.uniquePreceders.has(w_curr)) {
              this.uniquePreceders.set(w_curr, new Set());
            }
            this.uniquePreceders.get(w_curr)!.add(w_prev);
          }
        }
      }
    }

    this.totalUniqueBigrams = 0;
    for (const prevSet of this.uniquePreceders.values()) {
      this.totalUniqueBigrams += prevSet.size;
    }
  }

  getNgramCount(ngramArr: string[]): number {
    const order = ngramArr.length;
    if (order > this.maxOrder) return 0;
    return this.counts[order]!.get(ngramArr.join("|")) || 0;
  }

  getContextCount(contextArr: string[]): number {
    const order = contextArr.length;
    if (order + 1 > this.maxOrder) return 0;
    return this.contextTotals[order + 1]!.get(contextArr.join("|")) || 0;
  }

  getUniqueFollowersCount(contextArr: string[]): number {
    const order = contextArr.length;
    if (order + 1 > this.maxOrder) return 0;
    return this.followerCounts[order + 1]!.get(contextArr.join("|")) || 0;
  }

  getProbability(word: string, context: string[]): number {
    return this.calculateProbabilityRecursive(
      word,
      context.slice(-this.maxOrder + 1),
    );
  }

  private calculateProbabilityRecursive(
    word: string,
    context: string[],
  ): number {
    const order = context.length + 1;

    if (order === 1) {
      if (this.totalUniqueBigrams === 0) {
        return 1 / Math.max(1, this.vocab.size);
      }
      const uniquePrev = this.uniquePreceders.get(word)?.size || 0;
      const continuationProb = uniquePrev / this.totalUniqueBigrams;
      return continuationProb > 0
        ? continuationProb
        : 1 / Math.max(1, this.vocab.size);
    }

    const contextCount = this.getContextCount(context);
    if (contextCount === 0) {
      return this.calculateProbabilityRecursive(word, context.slice(1));
    }

    const ngramArr = [...context, word];
    const ngramCount = this.getNgramCount(ngramArr);

    const uniqueFollowers = this.getUniqueFollowersCount(context);
    const lambda = (this.discount / contextCount) * uniqueFollowers;

    const term1 = Math.max(ngramCount - this.discount, 0) / contextCount;
    const term2 =
      lambda * this.calculateProbabilityRecursive(word, context.slice(1));

    return term1 + term2;
  }
}

/**
 * Calculates the cross-entropy of a token sequence under the Kneser-Ney LM.
 */
export function calculateCrossEntropy(
  lm: KneserNeyLM,
  sequence: string[],
): number {
  if (sequence.length === 0) return 0;
  let logSum = 0;
  for (let i = 0; i < sequence.length; i++) {
    const word = sequence[i]!;
    const context = sequence.slice(Math.max(0, i - lm.maxOrder + 1), i);
    const prob = lm.getProbability(word, context);
    logSum += Math.log2(prob);
  }
  return -logSum / sequence.length;
}

/**
 * Calculates local token-level style evaluation scores using a rolling 20-token window.
 */
export function computeTokenScores(
  lm: KneserNeyLM,
  sequence: string[],
): number[] {
  const windowSize = 20;
  const tokenScores = new Array(sequence.length).fill(0);
  const tokenWindowCounts = new Array(sequence.length).fill(0);

  if (sequence.length < windowSize) {
    for (let i = 0; i < sequence.length; i++) {
      const context = sequence.slice(Math.max(0, i - lm.maxOrder + 1), i);
      tokenScores[i] = -Math.log2(lm.getProbability(sequence[i]!, context));
    }
    return tokenScores;
  }

  for (let i = 0; i <= sequence.length - windowSize; i++) {
    const windowSeq = sequence.slice(i, i + windowSize);
    const entropy = calculateCrossEntropy(lm, windowSeq);
    for (let j = i; j < i + windowSize; j++) {
      tokenScores[j] += entropy;
      tokenWindowCounts[j]++;
    }
  }

  for (let i = 0; i < sequence.length; i++) {
    if (tokenWindowCounts[i] > 0) {
      tokenScores[i] /= tokenWindowCounts[i];
    } else {
      const context = sequence.slice(Math.max(0, i - lm.maxOrder + 1), i);
      tokenScores[i] = -Math.log2(lm.getProbability(sequence[i]!, context));
    }
  }

  return tokenScores;
}

/**
 * Normalizes scores to [0, 1] where 1 is the most natural (lowest entropy) and 0 is the most anomalous.
 */
export function getNormalizedScores(scores: number[]): number[] {
  if (scores.length === 0) return [];
  const min = Math.min(...scores);
  const max = Math.max(...scores);
  const diff = max - min;
  if (diff === 0) return new Array(scores.length).fill(1);
  return scores.map((s) => (max - s) / diff);
}

/**
 * Dynamically trains the Kneser-Ney LM on all valid .trip files in the workspace.
 */
export async function getTrainedLM(excludeFile?: string): Promise<KneserNeyLM> {
  const lm = new KneserNeyLM(8);
  const workspacePath = workspaceRoot;
  const files = await discoverTripFiles([workspacePath]);
  const sequences: string[][] = [];

  for (const file of files) {
    if (excludeFile && resolve(file) === resolve(excludeFile)) continue;
    try {
      const content = await readFile(file, "utf8");
      parseTripLang(content);
      const fTokens = tokenizeFormatting(content);
      sequences.push(fTokens.map(getVocabRep));
    } catch {
      // Ignore invalid or unparseable files
    }
  }

  if (sequences.length === 0) {
    try {
      const preludePath = join(workspacePath, "lib", "prelude.trip");
      const content = await readFile(preludePath, "utf8");
      const fTokens = tokenizeFormatting(content);
      sequences.push(fTokens.map(getVocabRep));
    } catch {
      // Fallback
    }
  }

  lm.train(sequences);
  return lm;
}

/**
 * Dynamically trains the Kneser-Ney LM synchronously.
 */
let cachedSyncLM: KneserNeyLM | undefined;

export function getTrainedLMSync(excludeFile?: string): KneserNeyLM {
  // Training reads and tokenizes the entire .trip corpus, so cache the
  // corpus-wide model — the only variant any caller asks for. The leave-one-out
  // form (excludeFile) is rebuilt fresh: each exclusion is a different model and
  // is never on the hot path.
  if (excludeFile === undefined && cachedSyncLM !== undefined) {
    return cachedSyncLM;
  }

  const lm = new KneserNeyLM(8);
  const workspacePath = workspaceRoot;
  const sequences: string[][] = [];

  const dirs = [join(workspacePath, "lib"), join(workspacePath, "bootstrap")];
  for (const dir of dirs) {
    try {
      const stats = statSync(dir);
      if (stats.isDirectory()) {
        const entries = readdirSync(dir);
        for (const entry of entries) {
          const fullPath = join(dir, entry);
          if (entry.endsWith(".trip")) {
            if (excludeFile && resolve(fullPath) === resolve(excludeFile))
              continue;
            try {
              const content = readFileSync(fullPath, "utf8");
              parseTripLang(content);
              const fTokens = tokenizeFormatting(content);
              sequences.push(fTokens.map(getVocabRep));
            } catch {
              // Ignore invalid files
            }
          }
        }
      }
    } catch {
      // Ignore directory read errors
    }
  }

  if (sequences.length === 0) {
    try {
      const preludePath = join(workspacePath, "lib", "prelude.trip");
      const content = readFileSync(preludePath, "utf8");
      const fTokens = tokenizeFormatting(content);
      sequences.push(fTokens.map(getVocabRep));
    } catch {
      // Fallback
    }
  }

  lm.train(sequences);

  if (excludeFile === undefined) {
    cachedSyncLM = lm;
  }
  return lm;
}

import { readFileSync, readdirSync, statSync } from "node:fs";

/**
 * Performs unsupervised formatting deviation detection and generates safe, AST-equivalent fixes.
 */
export function getStatisticalDiagnostics(
  sourceText: string,
  lm: KneserNeyLM,
): any[] {
  const fTokens = tokenizeFormatting(sourceText);
  const sequence = fTokens.map(getVocabRep);
  if (sequence.length < 25 || sequence.length > 300) {
    return [];
  }
  const tokenScores = computeTokenScores(lm, sequence);
  const normalizedScores = getNormalizedScores(tokenScores); // 1 = natural, 0 = anomalous

  const diagnostics: any[] = [];
  let originalAstStr = "";
  try {
    originalAstStr = JSON.stringify(parseTripLang(sourceText));
  } catch {
    return []; // Only run on syntactically valid files
  }

  const originalEntropy = calculateCrossEntropy(lm, sequence);

  // 1. Scan and score all candidate tokens to build a ranked list of deviations
  const candidatesToEvaluate: { idx: number; modifiedErrProb: number }[] = [];

  for (let idx = 0; idx < fTokens.length; idx++) {
    const token = fTokens[idx]!;
    if (
      token.kind === "lineComment" ||
      token.kind === "blockComment" ||
      token.kind === "ident" ||
      token.kind === "string"
    ) {
      continue;
    }

    const context = sequence.slice(Math.max(0, idx - lm.maxOrder + 1), idx);
    const prob = lm.getProbability(sequence[idx]!, context);
    const errProb = 1 - prob;
    const normScore = normalizedScores[idx]!;
    const modifiedErrProb = errProb * (1 - normScore);

    if (modifiedErrProb > 0.5) {
      candidatesToEvaluate.push({ idx, modifiedErrProb });
    }
  }

  // 2. Sort by modifiedErrProb descending and limit to top 3 most critical layout issues
  candidatesToEvaluate.sort((a, b) => b.modifiedErrProb - a.modifiedErrProb);
  const topCandidates = candidatesToEvaluate.slice(0, 3);

  // 3. Evaluate spacing/newline fixes for the top layout deviations
  for (const item of topCandidates) {
    const idx = item.idx;
    const token = fTokens[idx]!;
    const candidates: {
      start: number;
      end: number;
      replacement: string;
      entropy: number;
    }[] = [];

    // Generate prospective edits
    const editOptions: { replacement: string; start: number; end: number }[] =
      [];

    // 1. Deletion (for spacing or newlines)
    if (token.kind === "space" || token.kind === "newline") {
      editOptions.push({ replacement: "", start: token.start, end: token.end });
    }

    // 2. Replacement
    if (token.kind === "space") {
      editOptions.push({
        replacement: "\n",
        start: token.start,
        end: token.end,
      });
    } else if (token.kind === "newline") {
      editOptions.push({
        replacement: " ",
        start: token.start,
        end: token.end,
      });
    }

    // 3. Insertion before
    editOptions.push({
      replacement: " ",
      start: token.start,
      end: token.start,
    });
    editOptions.push({
      replacement: "\n",
      start: token.start,
      end: token.start,
    });

    const prospectiveCandidates: {
      start: number;
      end: number;
      replacement: string;
      entropy: number;
    }[] = [];

    for (const edit of editOptions) {
      const editedText =
        sourceText.slice(0, edit.start) +
        edit.replacement +
        sourceText.slice(edit.end);

      const editedTokens = tokenizeFormatting(editedText).map(getVocabRep);
      const editedEntropy = calculateCrossEntropy(lm, editedTokens);
      // Must improve cross-entropy (naturalness)
      if (editedEntropy < originalEntropy * 0.99) {
        prospectiveCandidates.push({ ...edit, entropy: editedEntropy });
      }
    }

    // Sort by lowest entropy
    prospectiveCandidates.sort((a, b) => a.entropy - b.entropy);

    // Verify AST-equivalence starting from the best entropy candidate
    for (const cand of prospectiveCandidates) {
      const editedText =
        sourceText.slice(0, cand.start) +
        cand.replacement +
        sourceText.slice(cand.end);
      try {
        const editedAstStr = JSON.stringify(parseTripLang(editedText));
        if (editedAstStr === originalAstStr) {
          candidates.push(cand);
          break; // Found the best safe candidate; stop checking others!
        }
      } catch {
        // Reject invalid edits
      }
    }

    if (candidates.length > 0) {
      const best = candidates[0]!;

      // Determine line and column
      let line = 1;
      let column = 1;
      for (let charIdx = 0; charIdx < token.start; charIdx++) {
        if (sourceText[charIdx] === "\n") {
          line++;
          column = 1;
        } else {
          column++;
        }
      }

      diagnostics.push({
        code: "trip-formatting-deviation",
        message: `Unnatural spacing/layout formatting around "${token.text.replace(/\n/g, "\\n")}"`,
        line,
        column,
        offset: token.start,
        endOffset: token.end,
        fix: {
          start: best.start,
          end: best.end,
          replacement: best.replacement,
        },
      });
    }
  }

  return diagnostics;
}
