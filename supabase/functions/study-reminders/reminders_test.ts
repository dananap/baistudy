import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import {
  exportApplicationServerKey,
  exportVapidKeys,
  generateVapidKeys,
} from "@negrel/webpush";
import { createPushSender } from "./index.ts";
import {
  type PushPayload,
  type PushSubscriptionRow,
  type ReminderProfile,
  type ReminderRepository,
  runStudyReminders,
} from "./reminders.ts";

class FakeRepository implements ReminderRepository {
  counts = new Map<string, number>();
  claims = new Set<string>();
  removed: number[] = [];
  available = true;

  constructor(public profile: ReminderProfile) {}

  listProfiles(): Promise<ReminderProfile[]> {
    return Promise.resolve([this.profile]);
  }

  reviewCount(userId: number, localDate: string): Promise<number> {
    return Promise.resolve(this.counts.get(`${userId}:${localDate}`) ?? 0);
  }

  hasAvailableWork(): Promise<boolean> {
    return Promise.resolve(this.available);
  }

  hasDelivery(
    userId: number,
    localDate: string,
    kind: string,
  ): Promise<boolean> {
    return Promise.resolve(this.claims.has(`${userId}:${localDate}:${kind}`));
  }

  claim(userId: number, localDate: string, kind: string): Promise<boolean> {
    const key = `${userId}:${localDate}:${kind}`;
    if (this.claims.has(key)) return Promise.resolve(false);
    this.claims.add(key);
    return Promise.resolve(true);
  }

  removeSubscription(id: number): Promise<void> {
    this.removed.push(id);
    return Promise.resolve();
  }
}

function subscription(id = 1, locale = "en-US"): PushSubscriptionRow {
  return {
    id,
    user_id: 7,
    endpoint: `https://push.test/${id}`,
    p256dh: "public",
    auth: "secret",
    locale,
  };
}

function profile(overrides: Partial<ReminderProfile> = {}): ReminderProfile {
  return {
    user_id: 7,
    streak_days: 4,
    last_study_date: "2026-01-03",
    daily_review_goal: 20,
    study_timezone: "UTC",
    reminder_time: 12 * 60,
    reminder_followup: true,
    quiet_hours_start: 22 * 60,
    quiet_hours_end: 7 * 60,
    subscriptions: [subscription()],
    ...overrides,
  };
}

Deno.test("initial and follow-up reminders are localized and deduplicated", async () => {
  const repository = new FakeRepository(
    profile({ subscriptions: [subscription(1, "zh-CN")] }),
  );
  const payloads: PushPayload[] = [];
  const dependencies = {
    repository,
    send: (_subscription: PushSubscriptionRow, payload: PushPayload) => {
      payloads.push(payload);
      return Promise.resolve();
    },
  };
  const initial = new Date("2026-01-04T12:05:00Z");

  assertEquals((await runStudyReminders(dependencies, initial)).sent, 1);
  assertEquals((await runStudyReminders(dependencies, initial)).batches, 0);
  assertEquals(
    (await runStudyReminders(dependencies, new Date("2026-01-04T14:05:00Z")))
      .sent,
    1,
  );
  assertEquals(payloads.length, 2);
  assertStringIncludes(payloads[1].body, "4 天");
  assertEquals(payloads[1].tag, "study-2026-01-04-followup");
});

Deno.test("quiet hours, completed goals, and unavailable work suppress sends", async () => {
  const repository = new FakeRepository(profile({
    quiet_hours_start: 12 * 60,
    quiet_hours_end: 13 * 60,
  }));
  let sends = 0;
  const dependencies = {
    repository,
    send: () => {
      sends++;
      return Promise.resolve();
    },
  };
  const now = new Date("2026-01-04T12:05:00Z");
  assertEquals((await runStudyReminders(dependencies, now)).batches, 0);

  repository.profile.quiet_hours_start = repository.profile.quiet_hours_end = 0;
  repository.counts.set("7:2026-01-04", 20);
  assertEquals((await runStudyReminders(dependencies, now)).batches, 0);

  repository.counts.clear();
  repository.available = false;
  assertEquals((await runStudyReminders(dependencies, now)).batches, 0);
  assertEquals(sends, 0);
});

Deno.test("study date and reminder time use the browser timezone", async () => {
  const repository = new FakeRepository(profile({
    study_timezone: "Asia/Shanghai",
    reminder_time: 60,
    quiet_hours_start: 0,
    quiet_hours_end: 0,
    last_study_date: "2026-01-01",
  }));
  const payloads: PushPayload[] = [];
  await runStudyReminders({
    repository,
    send: (_subscription, payload) => {
      payloads.push(payload);
      return Promise.resolve();
    },
  }, new Date("2026-01-02T01:05:00+08:00"));
  assertEquals(payloads[0].tag, "study-2026-01-02-initial");
});

Deno.test("a stale streak uses factual recovery copy", async () => {
  const repository = new FakeRepository(
    profile({ last_study_date: "2025-12-30" }),
  );
  const payloads: PushPayload[] = [];
  await runStudyReminders({
    repository,
    send: (_subscription, payload) => {
      payloads.push(payload);
      return Promise.resolve();
    },
  }, new Date("2026-01-04T12:05:00Z"));
  assertEquals(payloads[0].title, "Start again today");
});

Deno.test("expired subscriptions are removed and other failures are counted", async () => {
  const repository = new FakeRepository(profile({
    subscriptions: [subscription(404), subscription(410), subscription(500)],
  }));
  const result = await runStudyReminders({
    repository,
    send: (subscription) => {
      const status = subscription.id;
      return Promise.reject({ response: { status } });
    },
    log: () => {},
  }, new Date("2026-01-04T12:05:00Z"));
  assertEquals(result, { batches: 1, sent: 0, removed: 2, failed: 1 });
  assertEquals(repository.removed, [404, 410]);
});

Deno.test("existing raw VAPID keys are accepted without rotation", async () => {
  const keys = await generateVapidKeys({ extractable: true });
  const exported = await exportVapidKeys(keys);
  const publicKey = await exportApplicationServerKey(keys);
  const sender = await createPushSender({
    publicKey,
    privateKey: exported.privateKey.d!,
    subject: "mailto:admin@example.com",
  });
  assertEquals(typeof sender, "function");
});

Deno.test("mismatched or malformed VAPID keys are rejected", async () => {
  const first = await generateVapidKeys({ extractable: true });
  const second = await generateVapidKeys({ extractable: true });
  const firstPublic = await exportApplicationServerKey(first);
  const secondPrivate = (await exportVapidKeys(second)).privateKey.d!;
  await assertRejects(
    () =>
      createPushSender({
        publicKey: firstPublic,
        privateKey: secondPrivate,
        subject: "mailto:admin@example.com",
      }),
    Error,
    "do not match",
  );
  await assertRejects(
    () =>
      createPushSender({
        publicKey: "bad",
        privateKey: "bad",
        subject: "mailto:admin@example.com",
      }),
    Error,
    "Invalid VAPID",
  );
});
