export type StatusPillTone = string;

export type StatusPillProps = {
  label: string | number;
  tone?: StatusPillTone;
  enabled?: boolean | null;
  showDot?: boolean;
  ariaLabel?: string;
};
