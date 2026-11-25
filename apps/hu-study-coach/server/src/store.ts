import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { Attempt, Exam, ExamItem, ExamRegrade, ModelSettings, QuestionRegion, Role, StoredAttachment, Worksheet } from "./contracts.ts";

interface ExamRow extends Omit<Exam, "attachments" | "items" | "hasPublishedResult"> {
	attachments: string;
	items: string;
	hasPublishedResult: 0 | 1;
}

type StoredExamItem = Omit<ExamItem, "verdict"> & { verdict?: ExamItem["verdict"] };

interface WorksheetRow {
	worksheet: string;
	attempt: string | null;
}

export interface WorksheetRecord {
	worksheet: Worksheet;
	attempt: Attempt | null;
}

type ExamDeletion = { kind: "deleted"; attachments: StoredAttachment[] } | { kind: "missing" } | { kind: "processing" };

const EXAM_COLUMNS = `id, title, subject, status, error, created_at AS createdAt,
	updated_at AS updatedAt, obtained, possible, worksheet_id AS worksheetId, revision,
	reference_text AS referenceText, attachments, items,
	EXISTS(SELECT 1 FROM grade_revisions WHERE exam_id = exams.id AND status = 'published') AS hasPublishedResult`;
const examLeaseMs = 6 * 60_000;

export class Store {
	private readonly db: DatabaseSync;

	constructor(path: string) {
		this.db = new DatabaseSync(path);
		this.db.exec(`
			PRAGMA foreign_keys = ON;
			PRAGMA journal_mode = WAL;
			PRAGMA busy_timeout = 5000;
			CREATE TABLE IF NOT EXISTS worksheets (
				id TEXT PRIMARY KEY, created_at TEXT NOT NULL, schedule_key TEXT UNIQUE,
				worksheet TEXT NOT NULL, attempt TEXT
			);
			CREATE TABLE IF NOT EXISTS removed_worksheet_schedules (
				schedule_key TEXT PRIMARY KEY NOT NULL
			);
			CREATE TABLE IF NOT EXISTS exams (
				id TEXT PRIMARY KEY, request_key TEXT NOT NULL UNIQUE, title TEXT NOT NULL,
				subject TEXT NOT NULL, status TEXT NOT NULL, error TEXT,
				created_at TEXT NOT NULL, updated_at TEXT NOT NULL, obtained REAL, possible REAL,
				worksheet_id TEXT REFERENCES worksheets(id), revision INTEGER NOT NULL DEFAULT 0,
				reference_text TEXT NOT NULL, attachments TEXT NOT NULL, items TEXT NOT NULL DEFAULT '[]',
				lease_id TEXT, lease_until TEXT
			);
			CREATE INDEX IF NOT EXISTS exam_queue ON exams(status, lease_until, created_at);
			CREATE UNIQUE INDEX IF NOT EXISTS paper_worksheet ON exams(worksheet_id) WHERE worksheet_id IS NOT NULL;
			CREATE TABLE IF NOT EXISTS grade_revisions (
				exam_id TEXT NOT NULL REFERENCES exams(id), revision INTEGER NOT NULL,
				saved_at TEXT NOT NULL, status TEXT NOT NULL, reference_text TEXT NOT NULL, items TEXT NOT NULL,
				PRIMARY KEY (exam_id, revision)
			);
			CREATE TABLE IF NOT EXISTS exam_regrades (
				exam_id TEXT NOT NULL, revision INTEGER NOT NULL, report TEXT NOT NULL,
				PRIMARY KEY (exam_id, revision),
				FOREIGN KEY (exam_id, revision) REFERENCES grade_revisions(exam_id, revision)
			);
			CREATE TABLE IF NOT EXISTS sessions (
				token_hash TEXT PRIMARY KEY, role TEXT NOT NULL, expires_at TEXT NOT NULL
			);
			CREATE TABLE IF NOT EXISTS model_settings (
				id INTEGER PRIMARY KEY CHECK(id = 1), provider TEXT NOT NULL CHECK(provider IN ('local', 'openai-codex')),
				local_model_id TEXT NOT NULL, codex_model_id TEXT NOT NULL, codex_reasoning_level TEXT NOT NULL DEFAULT 'low'
			);
		`);
		this.transaction(() => {
			const columns = this.db.prepare("PRAGMA table_info(model_settings)").all();
			if (!columns.some(({ name }) => name === "codex_reasoning_level")) {
				this.db.exec("ALTER TABLE model_settings ADD COLUMN codex_reasoning_level TEXT NOT NULL DEFAULT 'low'");
			}
		});
	}

	close(): void {
		this.db.close();
	}

	getModelSettings(): ModelSettings | null {
		return this.db.prepare(`SELECT provider, local_model_id AS localModelId, codex_model_id AS codexModelId,
			codex_reasoning_level AS codexReasoningLevel
			FROM model_settings WHERE id = 1`).get() as ModelSettings | undefined ?? null;
	}

	saveModelSettings(settings: ModelSettings): void {
		this.db.prepare(`INSERT INTO model_settings (id, provider, local_model_id, codex_model_id, codex_reasoning_level)
			VALUES (1, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET
			provider = excluded.provider, local_model_id = excluded.local_model_id, codex_model_id = excluded.codex_model_id,
			codex_reasoning_level = excluded.codex_reasoning_level`)
			.run(settings.provider, settings.localModelId, settings.codexModelId, settings.codexReasoningLevel);
	}

	addSession(tokenHash: string, role: Role, expiresAt: string): void {
		this.db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(new Date().toISOString());
		this.db.prepare("INSERT INTO sessions VALUES (?, ?, ?)").run(tokenHash, role, expiresAt);
	}

	getSession(tokenHash: string): Role | null {
		const row = this.db.prepare("SELECT role FROM sessions WHERE token_hash = ? AND expires_at > ?")
			.get(tokenHash, new Date().toISOString()) as { role: Role } | undefined;
		return row?.role ?? null;
	}

	removeSession(tokenHash: string): void {
		this.db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(tokenHash);
	}

	getExam(id: string): Exam | null {
		const row = this.db.prepare(`SELECT ${EXAM_COLUMNS} FROM exams WHERE id = ?`).get(id) as ExamRow | undefined;
		return row ? decodeExam(row) : null;
	}

	getExamRegrade(id: string, throughRevision = Number.MAX_SAFE_INTEGER): ExamRegrade | null {
		const row = this.db.prepare(`SELECT report FROM exam_regrades WHERE exam_id = ? AND revision <= ?
			ORDER BY revision DESC LIMIT 1`).get(id, throughRevision) as { report: string } | undefined;
		return row ? JSON.parse(row.report) as ExamRegrade : null;
	}

	findExamByRequest(requestKey: string): Exam | null {
		const row = this.db.prepare(`SELECT ${EXAM_COLUMNS} FROM exams WHERE request_key = ?`)
			.get(requestKey) as ExamRow | undefined;
		return row ? decodeExam(row) : null;
	}

	findPaperExam(worksheetId: string): Exam | null {
		const row = this.db.prepare(`SELECT ${EXAM_COLUMNS} FROM exams WHERE worksheet_id = ?`)
			.get(worksheetId) as ExamRow | undefined;
		return row ? decodeExam(row) : null;
	}

	listExams(): Exam[] {
		const rows = this.db.prepare(`SELECT ${EXAM_COLUMNS} FROM exams ORDER BY created_at DESC, id DESC`)
			.all() as unknown as ExamRow[];
		return rows.map(decodeExam);
	}

	createExam(exam: Exam, requestKey: string): boolean {
		return this.db.prepare(`INSERT INTO exams (id, request_key, title, subject, status, error, created_at,
			updated_at, worksheet_id, reference_text, attachments) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
			WHERE ? IS NULL OR EXISTS (SELECT 1 FROM worksheets WHERE id = ? AND attempt IS NULL)
			ON CONFLICT DO NOTHING`).run(exam.id, requestKey, exam.title, exam.subject, exam.status,
			exam.error, exam.createdAt, exam.updatedAt, exam.worksheetId, exam.referenceText,
			JSON.stringify(exam.attachments), exam.worksheetId, exam.worksheetId)
			.changes === 1;
	}

	deleteExam(id: string): ExamDeletion {
		return this.transaction(() => {
			const row = this.db.prepare("SELECT status, attachments FROM exams WHERE id = ?").get(id) as
				Pick<ExamRow, "status" | "attachments"> | undefined;
			if (!row) return { kind: "missing" };
			if (row.status === "processing") return { kind: "processing" };
			const attachments: StoredAttachment[] = JSON.parse(row.attachments);
			this.db.prepare("DELETE FROM exam_regrades WHERE exam_id = ?").run(id);
			this.db.prepare("DELETE FROM grade_revisions WHERE exam_id = ?").run(id);
			this.db.prepare("DELETE FROM exams WHERE id = ?").run(id);
			return { kind: "deleted", attachments };
		});
	}

	claimExam(now: Date): { exam: Exam; leaseId: string } | null {
		const leaseId = randomUUID();
		const current = now.toISOString();
		const leaseUntil = new Date(now.getTime() + examLeaseMs).toISOString();
		const row = this.db.prepare(`UPDATE exams SET status = 'processing', updated_at = ?, lease_id = ?, lease_until = ?
			WHERE id = (SELECT id FROM exams WHERE status = 'queued' OR (status = 'processing' AND lease_until <= ?)
			ORDER BY created_at, id LIMIT 1) RETURNING ${EXAM_COLUMNS}`)
			.get(current, leaseId, leaseUntil, current) as ExamRow | undefined;
		return row ? { exam: decodeExam(row), leaseId } : null;
	}

	renewExamLease(id: string, leaseId: string, now: Date): boolean {
		const leaseUntil = new Date(now.getTime() + examLeaseMs).toISOString();
		return this.db.prepare(`UPDATE exams SET lease_until = ?
			WHERE id = ? AND status = 'processing' AND lease_id = ? AND lease_until > ?`)
			.run(leaseUntil, id, leaseId, now.toISOString()).changes === 1;
	}

	finishExam(id: string, leaseId: string, result: { status: "published"; items: ExamItem[]; error: null;
		obtained: number | null; possible: number | null; regrade?: Omit<ExamRegrade, "completedAt"> }
		| { status: "review"; items: ExamItem[]; error: string | null }
		| { status: "queued"; error: null }
		| { status: "failed"; error: string }): void {
		this.transaction(() => {
			const now = new Date().toISOString();
			const items = "items" in result ? JSON.stringify(result.items) : null;
			const row = this.db.prepare(`UPDATE exams SET status = ?, updated_at = ?, error = ?,
				items = COALESCE(?, items), obtained = CASE WHEN ? THEN ? ELSE obtained END,
				possible = CASE WHEN ? THEN ? ELSE possible END, lease_id = NULL,
				lease_until = NULL, revision = revision + 1
				WHERE id = ? AND status = 'processing' AND lease_id = ? AND lease_until > ?
				RETURNING revision, reference_text AS referenceText`).get(result.status, now, result.error, items,
				result.status === "published" ? 1 : 0, result.status === "published" ? result.obtained : null,
				result.status === "published" ? 1 : 0, result.status === "published" ? result.possible : null, id, leaseId, now) as
				{ revision: number; referenceText: string } | undefined;
			if (row && result.status === "published") {
				this.db.prepare("INSERT INTO grade_revisions VALUES (?, ?, ?, ?, ?, ?)")
					.run(id, row.revision, now, result.status, row.referenceText, items);
				if (result.regrade) {
					const report: ExamRegrade = { ...result.regrade, completedAt: now };
					this.db.prepare("INSERT INTO exam_regrades (exam_id, revision, report) VALUES (?, ?, ?)")
						.run(id, row.revision, JSON.stringify(report));
				}
			}
		});
	}

	queueExam(id: string, revision: number): boolean {
		return this.db.prepare(`UPDATE exams SET status = 'queued', error = NULL, updated_at = ?, revision = revision + 1
			WHERE id = ? AND revision = ? AND status IN ('failed', 'review', 'published') AND attachments != '[]'`)
			.run(new Date().toISOString(), id, revision).changes === 1;
	}

	saveGrade(exam: Exam, next: { status: "review" | "published"; referenceText: string; items: ExamItem[];
		obtained: number | null; possible: number | null }): boolean {
		return this.transaction(() => {
			const now = new Date().toISOString();
			const items = JSON.stringify(next.items);
			const result = this.db.prepare(`UPDATE exams SET status = ?, reference_text = ?, items = ?, obtained = ?,
				possible = ?, updated_at = ?, error = NULL, revision = revision + 1
				WHERE id = ? AND revision = ? AND status IN ('review', 'published', 'failed')`)
				.run(next.status, next.referenceText, items, next.obtained, next.possible, now, exam.id, exam.revision);
			if (result.changes === 1) {
				this.db.prepare("INSERT INTO grade_revisions VALUES (?, ?, ?, ?, ?, ?)")
					.run(exam.id, exam.revision + 1, now, next.status, next.referenceText, items);
			}
			return result.changes === 1;
		});
	}

	saveExamItemRegion(exam: Exam, itemId: string, region: QuestionRegion): boolean {
		const itemIndex = exam.items.findIndex(({ id, page, verdict }) => id === itemId && page !== null && verdict === "incorrect");
		if (itemIndex < 0) return false;
		const items = exam.items.map((item, index): ExamItem => index === itemIndex
			? { ...item, imageRegion: region, imageSource: "manual" }
			: item);
		return this.db.prepare(`UPDATE exams SET items = ?, updated_at = ?, revision = revision + 1
			WHERE id = ? AND revision = ? AND status NOT IN ('queued', 'processing')
			AND (status = 'published' OR EXISTS(SELECT 1 FROM grade_revisions WHERE exam_id = exams.id AND status = 'published'))`)
			.run(JSON.stringify(items), new Date().toISOString(), exam.id, exam.revision).changes === 1;
	}

	getWorksheet(id: string): WorksheetRecord | null {
		const row = this.db.prepare("SELECT worksheet, attempt FROM worksheets WHERE id = ?")
			.get(id) as WorksheetRow | undefined;
		return row ? decodeWorksheet(row) : null;
	}

	listWorksheets(): WorksheetRecord[] {
		const rows = this.db.prepare("SELECT worksheet, attempt FROM worksheets ORDER BY created_at DESC, id DESC")
			.all() as unknown as WorksheetRow[];
		return rows.map(decodeWorksheet);
	}

	hasScheduledWorksheet(scheduleKey: string): boolean {
		return Boolean(this.db.prepare(`SELECT 1 FROM worksheets WHERE schedule_key = ?
			UNION ALL SELECT 1 FROM removed_worksheet_schedules WHERE schedule_key = ? LIMIT 1`).get(scheduleKey, scheduleKey));
	}

	addWorksheet(worksheet: Worksheet, scheduleKey: string | null): boolean {
		return this.db.prepare(`INSERT INTO worksheets (id, created_at, schedule_key, worksheet) SELECT ?, ?, ?, ?
			WHERE NOT EXISTS (SELECT 1 FROM removed_worksheet_schedules WHERE schedule_key = ?)
			ON CONFLICT(schedule_key) DO NOTHING`).run(worksheet.id, worksheet.createdAt, scheduleKey,
			JSON.stringify(worksheet), scheduleKey).changes === 1;
	}

	deleteWorksheet(id: string): boolean {
		return this.transaction(() => {
			const row = this.db.prepare("SELECT schedule_key AS scheduleKey FROM worksheets WHERE id = ?")
				.get(id) as { scheduleKey: string | null } | undefined;
			if (!row) return false;
			if (row.scheduleKey !== null) {
				// A deletion still counts as issuance for the original schedule slot.
				this.db.prepare("INSERT INTO removed_worksheet_schedules (schedule_key) VALUES (?)").run(row.scheduleKey);
			}
			this.db.prepare("UPDATE exams SET worksheet_id = NULL, updated_at = ?, revision = revision + 1 WHERE worksheet_id = ?")
				.run(new Date().toISOString(), id);
			return this.db.prepare("DELETE FROM worksheets WHERE id = ?").run(id).changes === 1;
		});
	}

	submitAttempt(id: string, attempt: Attempt): boolean {
		return this.db.prepare(`UPDATE worksheets SET attempt = ? WHERE id = ? AND attempt IS NULL
			AND NOT EXISTS (SELECT id FROM exams WHERE worksheet_id = ?)`)
			.run(JSON.stringify(attempt), id, id).changes === 1;
	}

	updateAttempt(id: string, current: Attempt, next: Attempt): boolean {
		return this.db.prepare("UPDATE worksheets SET attempt = ? WHERE id = ? AND attempt = ?")
			.run(JSON.stringify(next), id, JSON.stringify(current)).changes === 1;
	}

	private transaction<T>(operation: () => T): T {
		this.db.exec("BEGIN IMMEDIATE");
		try {
			const result = operation();
			this.db.exec("COMMIT");
			return result;
		} catch (error) {
			this.db.exec("ROLLBACK");
			throw error;
		}
	}
}

function decodeExam(row: ExamRow): Exam {
	const stored: StoredExamItem[] = JSON.parse(row.items);
	const items = stored.map((item): ExamItem => {
		if (item.verdict) return { ...item, verdict: item.verdict };
		const verdict = item.requiresReview || item.score === null || item.maxScore === null
			? "uncertain" : item.score === item.maxScore ? "correct" : "incorrect";
		return { ...item, verdict };
	});
	return { ...row, hasPublishedResult: row.status === "published" || row.hasPublishedResult === 1,
		attachments: JSON.parse(row.attachments), items };
}

function decodeWorksheet(row: WorksheetRow): WorksheetRecord {
	return { worksheet: JSON.parse(row.worksheet), attempt: row.attempt ? JSON.parse(row.attempt) : null };
}
