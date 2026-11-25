import type { ThinkingLevel } from "@earendil-works/pi-ai";
import { z } from "zod";

export const SUBJECT_LABELS = { chinese: "语文", math: "数学", english: "英语" } as const;
export const subjectSchema = z.enum(["chinese", "math", "english"]);
export const difficultySchema = z.enum(["basic", "standard", "transfer"]);
export const worksheetModeSchema = z.enum(["review", "assessment"]);
export const roleSchema = z.enum(["student", "reviewer"]);
export const verdictSchema = z.enum(["correct", "incorrect", "uncertain"]);

export type Subject = z.infer<typeof subjectSchema>;
export type Difficulty = z.infer<typeof difficultySchema>;
export type Role = z.infer<typeof roleSchema>;
export type Verdict = z.infer<typeof verdictSchema>;
export type ExamStatus = "queued" | "processing" | "review" | "published" | "failed";
export type ModelProvider = "local" | "openai-codex";

export interface ModelSettings {
	provider: ModelProvider;
	localModelId: string;
	codexModelId: string;
	codexReasoningLevel: ThinkingLevel;
}

export const questionRegionSchema = z.strictObject({
	x: z.number().int().min(0).max(999),
	y: z.number().int().min(0).max(999),
	width: z.number().int().min(10).max(1_000),
	height: z.number().int().min(10).max(1_000),
}).refine(({ x, y, width, height }) => x + width <= 1_000 && y + height <= 1_000 && width * height <= 980_000);

export type QuestionRegion = z.infer<typeof questionRegionSchema>;

export const markingItemSchema = z.object({
	number: z.string().trim().min(1).max(40),
	prompt: z.string().trim().min(1).max(6_000),
	response: z.string().max(8_000),
	verdict: verdictSchema,
	maxScore: z.number().positive().max(1_000).nullable(),
	score: z.number().min(0).max(1_000).nullable(),
	referenceAnswer: z.string().max(6_000),
	rubric: z.string().max(6_000),
	feedback: z.string().max(6_000),
	skillId: z.string().max(100).nullable(),
	errorCause: z.string().max(120),
	page: z.number().int().min(1).max(1_000).nullable(),
	evidence: z.string().max(2_000),
	difficulty: difficultySchema,
	requiresReview: z.boolean(),
	imageRegion: questionRegionSchema.optional(),
});

export type MarkingItem = z.infer<typeof markingItemSchema>;
export type ExamItem = MarkingItem & { id: string; imageSource?: "manual" | "automatic"; ignored?: boolean };
export const UNRECOGNIZED_PAGE_PROMPT = "这一页未识别到可批改的题目";

export type RegradeSnapshot = Pick<ExamItem, "verdict" | "score" | "maxScore">;
export type RegradeField = "verdict" | "score" | "prompt" | "response" | "referenceAnswer";

export type RegradeChange = Pick<ExamItem, "page" | "number"> & { itemId: string } & (
	| { kind: "changed"; before: RegradeSnapshot; after: RegradeSnapshot; fields: RegradeField[] }
	| { kind: "added"; after: RegradeSnapshot }
	| { kind: "retained"; before: RegradeSnapshot }
);

export interface ExamRegrade {
	completedAt: string;
	changes: RegradeChange[];
	pageIssues: { page: number; message: string }[];
	newItemCount: number;
	retainedItemCount: number;
}

export interface StoredAttachment {
	id: string;
	name: string;
	mimeType: string;
	path: string;
}

interface ExamOverview {
	id: string;
	title: string;
	subject: Subject;
	status: ExamStatus;
	error: string | null;
	createdAt: string;
	obtained: number | null;
	possible: number | null;
	worksheetId: string | null;
	hasPublishedResult?: boolean;
}

export interface ExamSummary extends ExamOverview {
	hasPublishedResult: boolean;
	retryAvailable: boolean;
	correctCount: number;
	incorrectCount: number;
	uncertainCount: number;
}

export interface Exam extends ExamOverview {
	revision: number;
	updatedAt: string;
	referenceText: string;
	attachments: StoredAttachment[];
	items: ExamItem[];
}

export interface Skill {
	id: string;
	label: string;
	subject: Subject;
}

export interface PracticeQuestion {
	id: string;
	familyId: string;
	skillId: string;
	sourceKey?: string;
	difficulty: Difficulty;
	prompt: string;
	acceptedAnswers: string[];
	solution: string;
	maxScore: number;
	rubric: string;
	responseType: "exact" | "review";
}

export interface Worksheet {
	id: string;
	subject: Subject;
	title: string;
	createdAt: string;
	mode: z.infer<typeof worksheetModeSchema>;
	questions: PracticeQuestion[];
	uncoveredSkillIds: string[];
}

export interface PracticeTarget {
	id: string;
	skillId: string;
	skillLabel?: string;
	difficulty: Difficulty;
	maxScore: number;
	responseType: PracticeQuestion["responseType"];
	source?: { prompt: string; errorCause: string };
	sourceKey?: string;
	avoidPrompts?: readonly string[];
}

export interface PracticeDraft {
	targetId: string;
	prompt: string;
	acceptedAnswers: string[];
	solution: string;
	rubric: string;
}

export interface PracticeGenerationInput {
	subject: Subject;
	mode: Worksheet["mode"];
	targets: readonly PracticeTarget[];
}

export interface AttemptItem {
	questionId: string;
	response: string;
	score: number | null;
	feedback: string;
}

export interface Attempt {
	createdAt: string;
	assisted: boolean;
	items: AttemptItem[];
}

export interface Wrong {
	examId: string | null;
	worksheetId: string | null;
	itemId: string;
	subject: Subject;
	number: string;
	prompt: string;
	feedback: string;
	skillId: string | null;
	errorCause: string;
	difficulty: Difficulty;
	occurrences: number;
	dueAt: string | null;
	mastered: boolean;
	sourcePage: number | null;
	hasScreenshot: boolean;
}

export interface TrendPoint {
	subject: Subject;
	date: string;
	correct: number;
	total: number;
	worksheetIds: string[];
}
