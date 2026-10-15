import {
  parseBotRoutineDate,
  parseBotRoutineTime,
  type BotRoutineSchedule,
} from "./bot-routine-schedule.js";

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const SHORT_DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const SHORT_MONTH_NAMES = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

function clockTime(value: string): string {
  const { hour, minute } = parseBotRoutineTime(value);
  const period = hour < 12 ? "AM" : "PM";
  const displayHour = hour % 12 === 0 ? 12 : hour % 12;
  return `${displayHour}:${String(minute).padStart(2, "0")} ${period}`;
}

function ordinal(value: number): string {
  const lastTwo = value % 100;
  if (lastTwo >= 11 && lastTwo <= 13) return `${value}th`;
  switch (value % 10) {
    case 1:
      return `${value}st`;
    case 2:
      return `${value}nd`;
    case 3:
      return `${value}rd`;
    default:
      return `${value}th`;
  }
}

function joinNames(names: readonly string[]): string {
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

function weeklyPhrase(days: readonly number[]): string {
  const unique = [...new Set(days)].sort((a, b) => a - b);
  if (unique.length === 7) return "Every day";
  if (unique.length === 5 && unique.every((day, index) => day === index + 1)) return "Weekdays";
  if (unique.length === 1) return `Every ${DAY_NAMES[unique[0]!]}`;
  return `Every ${joinNames(unique.map((day) => SHORT_DAY_NAMES[day]!))}`;
}

export interface BotRoutineLabelOptions {
  /** When set, a one-off routine outside this year also names its year. */
  currentYear?: number;
}

/** Plain-language row label, for example "Every Sunday at 8:41 AM". */
export function formatBotRoutineLabel(
  schedule: BotRoutineSchedule,
  options: BotRoutineLabelOptions = {},
): string {
  const at = `at ${clockTime(schedule.time)}`;
  switch (schedule.kind) {
    case "daily":
      return `Every day ${at}`;
    case "weekdays":
      return `Weekdays ${at}`;
    case "weekly":
      return `${weeklyPhrase(schedule.days)} ${at}`;
    case "monthly":
      return `Monthly on the ${ordinal(schedule.day)} ${at}`;
    case "once": {
      const { year, month, day } = parseBotRoutineDate(schedule.date);
      const yearSuffix =
        options.currentYear !== undefined && options.currentYear !== year ? `, ${year}` : "";
      return `Once on ${SHORT_MONTH_NAMES[month - 1]} ${day}${yearSuffix} ${at}`;
    }
  }
}
