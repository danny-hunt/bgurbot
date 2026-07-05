import { Notification } from "electron";
import type { Settings } from "@shared/types";

let opts: { getSettings: () => Settings; onActivate: () => void } | null = null;
let timer: NodeJS.Timeout | null = null;

/** ms until the next local occurrence of "HH:MM", or null if invalid/empty. */
const msUntilNext = (hhmm: string): number | null => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm);
  if (!m) return null;
  const hours = Number(m[1]);
  const minutes = Number(m[2]);
  if (hours > 23 || minutes > 59) return null;
  const now = new Date();
  const next = new Date(now);
  next.setHours(hours, minutes, 0, 0);
  // The 1s slack avoids an immediate re-fire when the timer wakes a hair early.
  if (next.getTime() <= now.getTime() + 1000) next.setDate(next.getDate() + 1);
  return next.getTime() - now.getTime();
};

const showNotification = () => {
  if (!opts || !Notification.isSupported()) return;
  const settings = opts.getSettings();
  const anchor = settings.habitAnchor.trim();
  const notification = anchor
    ? new Notification({
        title: "Urdu time",
        body: `After I ${anchor} — time for today's dose.`,
      })
    : new Notification({
        title: "Urdu time",
        body: `Time for today's Urdu dose — ${settings.dailyDoseCards} sentences and you're done.`,
      });
  notification.on("click", () => opts?.onActivate());
  notification.show();
};

/** (Re)schedule the daily reminder from current settings. Safe to call anytime. */
export const rescheduleReminder = (): void => {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  if (!opts || !Notification.isSupported()) return;
  const ms = msUntilNext(opts.getSettings().dailyReminderTime);
  if (ms === null) return;
  timer = setTimeout(() => {
    showNotification();
    rescheduleReminder(); // tomorrow
  }, ms);
};

export const initReminder = (options: {
  getSettings: () => Settings;
  onActivate: () => void;
}): void => {
  opts = options;
  rescheduleReminder();
};
