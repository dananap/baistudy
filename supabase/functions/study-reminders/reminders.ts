export interface PushSubscriptionRow {
  id: number;
  user_id: number;
  endpoint: string;
  p256dh: string;
  auth: string;
  locale: string;
}

export interface ReminderProfile {
  user_id: number;
  streak_days: number | null;
  last_study_date: string | null;
  daily_review_goal: number | null;
  study_timezone: string | null;
  reminder_time: number | null;
  reminder_followup: boolean | null;
  quiet_hours_start: number | null;
  quiet_hours_end: number | null;
  subscriptions: PushSubscriptionRow[];
}

export interface ReminderRepository {
  listProfiles(): Promise<ReminderProfile[]>;
  reviewCount(userId: number, localDate: string): Promise<number>;
  hasAvailableWork(userId: number, now: Date): Promise<boolean>;
  hasDelivery(
    userId: number,
    localDate: string,
    kind: string,
  ): Promise<boolean>;
  claim(userId: number, localDate: string, kind: string): Promise<boolean>;
  removeSubscription(id: number): Promise<void>;
}

export interface PushPayload {
  title: string;
  body: string;
  url: string;
  tag: string;
}

export interface ReminderDependencies {
  repository: ReminderRepository;
  send(subscription: PushSubscriptionRow, payload: PushPayload): Promise<void>;
  log?(message: string, context: Record<string, unknown>): void;
}

export interface ReminderTotals {
  batches: number;
  sent: number;
  removed: number;
  failed: number;
}

function localParts(
  now: Date,
  timeZone: string,
): { date: string; minute: number } {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(now);
    const values = Object.fromEntries(
      parts.map((part) => [part.type, part.value]),
    );
    return {
      date: `${values.year}-${values.month}-${values.day}`,
      minute: Number(values.hour) * 60 + Number(values.minute),
    };
  } catch {
    return localParts(now, "UTC");
  }
}

function previousDate(date: string): string {
  const [year, month, day] = date.split("-").map(Number);
  const previous = new Date(Date.UTC(year, month - 1, day - 1));
  return previous.toISOString().slice(0, 10);
}

function quietNow(profile: ReminderProfile, minute: number): boolean {
  const start = profile.quiet_hours_start ?? 22 * 60;
  const end = profile.quiet_hours_end ?? 7 * 60;
  if (start === end) return false;
  return start > end
    ? minute >= start || minute < end
    : start <= minute && minute < end;
}

function reminderCopy(
  profile: ReminderProfile,
  remaining: number,
  kind: string,
  recovered: boolean,
  locale: string,
): { title: string; body: string } {
  const chinese = locale.toLowerCase().startsWith("zh");
  if (kind === "followup" && (profile.streak_days ?? 0) > 0 && !recovered) {
    return chinese
      ? {
        title: "别断了连续学习",
        body:
          `你的 ${profile.streak_days} 天连续记录今天还未完成，再复习 ${remaining} 次即可保住。`,
      }
      : {
        title: "Keep your streak alive",
        body:
          `Your ${profile.streak_days}-day streak is at risk · ${remaining} review${
            remaining === 1 ? "" : "s"
          } to keep it.`,
      };
  }
  if (recovered) {
    return chinese
      ? {
        title: "今天重新开始",
        body: `连续记录可以重新积累。今天先完成 ${remaining} 次复习。`,
      }
      : {
        title: "Start again today",
        body: `Build a new streak with ${remaining} reviews today.`,
      };
  }
  return chinese
    ? {
      title: "今天的中文学习",
      body: `今天还需复习 ${remaining} 次。完成你的每日目标。`,
    }
    : {
      title: "Time for Chinese",
      body: `${remaining} review${
        remaining === 1 ? "" : "s"
      } left today. Keep your daily commitment.`,
    };
}

function errorStatus(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null || !("response" in error)) {
    return undefined;
  }
  const response = error.response;
  if (
    typeof response !== "object" || response === null || !("status" in response)
  ) return undefined;
  return typeof response.status === "number" ? response.status : undefined;
}

export async function runStudyReminders(
  { repository, send, log = console.error }: ReminderDependencies,
  now = new Date(),
): Promise<ReminderTotals> {
  const totals: ReminderTotals = { batches: 0, sent: 0, removed: 0, failed: 0 };
  const profiles = await repository.listProfiles();
  for (const profile of profiles) {
    try {
      const local = localParts(now, profile.study_timezone || "UTC");
      if (quietNow(profile, local.minute)) continue;
      const remaining = Math.max(
        0,
        (profile.daily_review_goal || 20) -
          await repository.reviewCount(profile.user_id, local.date),
      );
      if (
        remaining === 0 ||
        !await repository.hasAvailableWork(profile.user_id, now)
      ) continue;

      const elapsed = local.minute - (profile.reminder_time ?? 19 * 60);
      let kind: string | undefined;
      if (elapsed >= 0 && elapsed <= 60) {
        kind = "initial";
      } else if (
        profile.reminder_followup && elapsed >= 120 && elapsed <= 180 &&
        await repository.hasDelivery(profile.user_id, local.date, "initial")
      ) {
        kind = "followup";
      }
      if (!kind || !await repository.claim(profile.user_id, local.date, kind)) {
        continue;
      }

      const recovered = !!profile.last_study_date &&
        ![local.date, previousDate(local.date)].includes(
          profile.last_study_date,
        );
      totals.batches++;
      for (const subscription of profile.subscriptions) {
        const copy = reminderCopy(
          profile,
          remaining,
          kind,
          recovered,
          subscription.locale || "en",
        );
        try {
          await send(subscription, {
            ...copy,
            url: "/",
            tag: `study-${local.date}-${kind}`,
          });
          totals.sent++;
        } catch (error) {
          const status = errorStatus(error);
          if (status === 404 || status === 410) {
            await repository.removeSubscription(subscription.id);
            totals.removed++;
          } else {
            totals.failed++;
            log("push delivery failed", {
              user_id: profile.user_id,
              subscription_id: subscription.id,
              status,
            });
          }
        }
      }
    } catch (error) {
      log("study reminder user failed", { user_id: profile.user_id, error });
    }
  }
  return totals;
}
