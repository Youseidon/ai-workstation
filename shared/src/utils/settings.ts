import type { SettingScale } from "../contracts/settings.ts";

export function formatSettingValue(value: number, scale: SettingScale, short = false): string {
  if (value === 0 && scale.zeroLabel !== null) return short ? "∞" : scale.zeroLabel;
  const trim = (amount: number): string => String(Math.round(amount * 10) / 10);
  switch (scale.unit) {
    case "usd":
      return `$${value.toLocaleString("en-US")}`;
    case "minutes": {
      if (value < 60) return short ? `${value}m` : `${value} min`;
      const hours = Math.floor(value / 60);
      const minutes = value % 60;
      if (short) return `${trim(value / 60)}h`;
      return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
    }
    case "ms":
      return value < 1000 ? (short ? `${value}ms` : `${value} ms`) : `${trim(value / 1000)}s`;
    case "days": {
      if (value % 365 === 0) return short ? `${value / 365}y` : value === 365 ? "1 year" : `${value / 365} years`;
      return short ? `${value}d` : value === 1 ? "1 day" : `${value} days`;
    }
    case "bytes": {
      const space = short ? "" : " ";
      if (value >= 1_048_576) return `${trim(value / 1_048_576)}${space}MB`;
      if (value >= 1024) return `${trim(value / 1024)}${space}KB`;
      return `${value}${space}B`;
    }
    case "count": {
      if (short) return value >= 1000 ? `${trim(value / 1000)}k` : String(value);
      const amount = value.toLocaleString("en-US");
      return scale.noun === null ? amount : `${amount} ${scale.noun}${value === 1 ? "" : "s"}`;
    }
  }
}
