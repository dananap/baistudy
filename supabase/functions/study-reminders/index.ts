import { ApplicationServer, importVapidKeys } from "@negrel/webpush";
import { withSupabase } from "@supabase/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  type PushPayload,
  type PushSubscriptionRow,
  type ReminderProfile,
  type ReminderRepository,
  runStudyReminders,
} from "./reminders.ts";

class SupabaseReminderRepository implements ReminderRepository {
  constructor(private readonly client: SupabaseClient) {}

  // user_profile and push_subscriptions both reference users with no FK
  // between them, so PostgREST can't embed one in the other: load both
  // and join here.
  async listProfiles(): Promise<ReminderProfile[]> {
    const profiles = new Map<number, ReminderProfile>();
    const pageSize = 1000;
    for (let from = 0;; from += pageSize) {
      const { data, error } = await this.client
        .from("user_profile")
        .select(
          "user_id,streak_days,last_study_date,daily_review_goal,study_timezone,reminder_time,reminder_followup,quiet_hours_start,quiet_hours_end",
        )
        .eq("reminder_enabled", true)
        .order("user_id")
        .range(from, from + pageSize - 1);
      if (error) throw error;
      for (const row of data ?? []) {
        profiles.set(row.user_id, { ...row, subscriptions: [] });
      }
      if (!data || data.length < pageSize) break;
    }
    const userIds = [...profiles.keys()];
    for (let i = 0; i < userIds.length; i += 200) {
      const chunk = userIds.slice(i, i + 200);
      for (let from = 0;; from += pageSize) {
        const { data, error } = await this.client
          .from("push_subscriptions")
          .select("id,user_id,endpoint,p256dh,auth,locale")
          .in("user_id", chunk)
          .order("id")
          .range(from, from + pageSize - 1);
        if (error) throw error;
        for (const row of data ?? []) {
          profiles.get(row.user_id)?.subscriptions.push(row);
        }
        if (!data || data.length < pageSize) break;
      }
    }
    return [...profiles.values()].filter((p) => p.subscriptions.length > 0);
  }

  async reviewCount(userId: number, localDate: string): Promise<number> {
    const { data, error } = await this.client
      .from("study_days")
      .select("review_count")
      .eq("user_id", userId)
      .eq("study_date", localDate)
      .maybeSingle();
    if (error) throw error;
    return data?.review_count ?? 0;
  }

  async hasAvailableWork(userId: number, now: Date): Promise<boolean> {
    const { data, error } = await this.client
      .from("cards")
      .select("id")
      .eq("user_id", userId)
      .eq("is_suspended", false)
      .or(`and(reps.gt.0,due.lte.${now.toISOString()}),reps.eq.0`)
      .limit(1);
    if (error) throw error;
    return (data?.length ?? 0) > 0;
  }

  async hasDelivery(
    userId: number,
    localDate: string,
    kind: string,
  ): Promise<boolean> {
    const { data, error } = await this.client
      .from("reminder_deliveries")
      .select("id")
      .eq("user_id", userId)
      .eq("local_date", localDate)
      .eq("kind", kind)
      .maybeSingle();
    if (error) throw error;
    return data !== null;
  }

  async claim(
    userId: number,
    localDate: string,
    kind: string,
  ): Promise<boolean> {
    const { error } = await this.client
      .from("reminder_deliveries")
      .insert({ user_id: userId, local_date: localDate, kind });
    if (!error) return true;
    if (error.code === "23505") return false;
    throw error;
  }

  async removeSubscription(id: number): Promise<void> {
    const { error } = await this.client.from("push_subscriptions").delete().eq(
      "id",
      id,
    );
    if (error) throw error;
  }
}

function decodeBase64Url(value: string): Uint8Array {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(normalized + "=".repeat((4 - normalized.length % 4) % 4));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function encodeBase64Url(value: Uint8Array): string {
  const binary = Array.from(value, (byte) => String.fromCharCode(byte)).join(
    "",
  );
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(
    /=+$/g,
    "",
  );
}

export async function createPushSender(configuration: {
  publicKey: string;
  privateKey: string;
  subject: string;
}) {
  const publicBytes = decodeBase64Url(configuration.publicKey);
  const privateBytes = decodeBase64Url(configuration.privateKey);
  if (
    publicBytes.length !== 65 || publicBytes[0] !== 4 ||
    privateBytes.length !== 32
  ) {
    throw new Error("Invalid VAPID key configuration");
  }
  const publicJwk = {
    kty: "EC",
    crv: "P-256",
    x: encodeBase64Url(publicBytes.slice(1, 33)),
    y: encodeBase64Url(publicBytes.slice(33, 65)),
  };
  const vapidKeys = await importVapidKeys({
    publicKey: publicJwk,
    privateKey: { ...publicJwk, d: encodeBase64Url(privateBytes) },
  });
  const challenge = new TextEncoder().encode("VAPID key correspondence");
  const algorithm = { name: "ECDSA", hash: "SHA-256" };
  const signature = await crypto.subtle.sign(
    algorithm,
    vapidKeys.privateKey,
    challenge,
  );
  if (
    !await crypto.subtle.verify(
      algorithm,
      vapidKeys.publicKey,
      signature,
      challenge,
    )
  ) {
    throw new Error("VAPID public and private keys do not match");
  }
  const server = await ApplicationServer.new({
    contactInformation: configuration.subject,
    vapidKeys,
  });
  return (subscription: PushSubscriptionRow, payload: PushPayload) =>
    server.subscribe({
      endpoint: subscription.endpoint,
      keys: { p256dh: subscription.p256dh, auth: subscription.auth },
    }).pushTextMessage(JSON.stringify(payload), { ttl: 3600 });
}

export default {
  fetch: withSupabase({ auth: "secret" }, async (_request, context) => {
    const publicKey = Deno.env.get("VAPID_PUBLIC_KEY");
    const privateKey = Deno.env.get("VAPID_PRIVATE_KEY");
    const subject = Deno.env.get("VAPID_SUBJECT");
    if (!publicKey || !privateKey || !subject) {
      return Response.json({ error: "Web Push is not configured" }, {
        status: 503,
      });
    }
    const repository = new SupabaseReminderRepository(context.supabaseAdmin);
    const send = await createPushSender({ publicKey, privateKey, subject });
    return Response.json(await runStudyReminders({ repository, send }));
  }),
};
