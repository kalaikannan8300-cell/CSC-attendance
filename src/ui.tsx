import type { ReactNode } from "react"

import { attendanceCounts } from "./attendance-metrics"

export function Icon({
  name,
  className = "",
}: {
  name: "check" | "arrow" | "upload" | "image" | "trash" | "replace" | "clock" | "shield" | "menu" | "students" | "edit" | "search" | "plus"
  className?: string
}) {
  const paths: Record<string, ReactNode> = {
    check: <path d="m5 12 4 4L19 6" />,
    arrow: <path d="m9 18 6-6-6-6" />,
    upload: (
      <>
        <path d="M12 3v12" />
        <path d="m7 8 5-5 5 5" />
        <path d="M5 21h14" />
      </>
    ),
    image: (
      <>
        <rect x="3" y="4" width="18" height="16" rx="2" />
        <circle cx="8.5" cy="9" r="1.5" />
        <path d="m21 15-5-5L5 20" />
      </>
    ),
    trash: (
      <>
        <path d="M4 7h16" />
        <path d="M9 7V4h6v3" />
        <path d="m6 7 1 14h10l1-14" />
      </>
    ),
    replace: (
      <>
        <path d="M20 7h-5V2" />
        <path d="M4 17h5v5" />
        <path d="M6.1 9A7 7 0 0 1 18.4 5.6L20 7" />
        <path d="M17.9 15A7 7 0 0 1 5.6 18.4L4 17" />
      </>
    ),
    clock: (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 7v5l3 2" />
      </>
    ),
    shield: (
      <>
        <path d="M12 3 5 6v5c0 4.5 2.8 8.2 7 10 4.2-1.8 7-5.5 7-10V6l-7-3Z" />
        <path d="m9 12 2 2 4-4" />
      </>
    ),
    menu: (
      <>
        <path d="M5 8h14" />
        <path d="M5 16h14" />
      </>
    ),
    students: (
      <>
        <path d="M16 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
        <circle cx="10" cy="7" r="4" />
        <path d="M20 21v-2a4 4 0 0 0-3-3.87" />
        <path d="M16 3.13a4 4 0 0 1 0 7.75" />
      </>
    ),
    edit: (
      <>
        <path d="M12 20h9" />
        <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4Z" />
      </>
    ),
    search: (
      <>
        <circle cx="11" cy="11" r="7" />
        <path d="m20 20-4-4" />
      </>
    ),
    plus: (
      <>
        <path d="M12 5v14" />
        <path d="M5 12h14" />
      </>
    ),
  }

  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name]}
    </svg>
  )
}
export function AttendancePieChart({
  presentDays,
  absentDays,
  label,
  compact = false,
}: {
  presentDays: number
  absentDays: number
  label: string
  compact?: boolean
}) {
  const { totalDays, presentPercentage, absentPercentage } = attendanceCounts(
    presentDays,
    absentDays,
  )
  const ratio = totalDays === 0 ? 0 : presentDays / totalDays
  const angle = ratio * Math.PI * 2
  const endX = 50 + 50 * Math.sin(angle)
  const endY = 50 - 50 * Math.cos(angle)
  const presentSlice =
    ratio >= 1
      ? null
      : `M 50 50 L 50 0 A 50 50 0 ${ratio > 0.5 ? 1 : 0} 1 ${endX} ${endY} Z`

  return (
    <div
      className={`attendance-pie${compact ? " attendance-pie-compact" : ""}`}
      role="img"
      aria-label={`${label}: ${presentDays} present, ${absentDays} absent; ${
        presentPercentage === null
          ? "present percentage not available"
          : `${presentPercentage.toFixed(1)} percent present and ${
              absentPercentage?.toFixed(1) ?? "N/A"
            } percent absent`
      }`}
    >
      <svg
        className="attendance-pie-graphic"
        viewBox="0 0 100 100"
        aria-hidden="true"
      >
        <circle
          cx="50"
          cy="50"
          r="50"
          fill={totalDays === 0 ? "#e7eae6" : "#d9867f"}
        />
        {presentDays > 0 &&
          (presentSlice ? (
            <path d={presentSlice} fill="#66866d" />
          ) : (
            <circle cx="50" cy="50" r="50" fill="#66866d" />
          ))}
      </svg>
      <div className="attendance-pie-details">
        <strong>
          {presentPercentage === null
            ? "N/A"
            : `${presentPercentage.toFixed(1)}%`}
        </strong>
        <span>Present</span>
        <div className="attendance-pie-legend">
          <span>
            <i className="present" /> Present{" "}
            <b>
              {presentDays} (
              {presentPercentage === null
                ? "N/A"
                : `${presentPercentage.toFixed(1)}%`}
              )
            </b>
          </span>
          <span>
            <i className="absent" /> Absent{" "}
            <b>
              {absentDays} (
              {absentPercentage === null
                ? "N/A"
                : `${absentPercentage.toFixed(1)}%`}
              )
            </b>
          </span>
        </div>
      </div>
    </div>
  )
}

export function Brand({ light = false }: { light?: boolean }) {
  return (
    <div className={`brand ${light ? "brand-light" : ""}`}>
      <picture>
        <source
          type="image/webp"
          srcSet="/assets/csc-logo-360.webp?v=20261018-1 360w, /assets/csc-logo.webp?v=20261018-1 535w"
          sizes="(max-width: 420px) 160px, 180px"
        />
        <img
          src="/assets/csc-logo.png?v=20261016-3"
          width="535"
          height="390"
          decoding="async"
          alt="CSC Computer Software College"
        />
      </picture>
    </div>
  )
}

export function Button({
  children,
  variant = "primary",
  type = "button",
  disabled,
  onClick,
}: {
  children: ReactNode
  variant?: "primary" | "secondary" | "quiet" | "danger"
  type?: "button" | "submit"
  disabled?: boolean
  onClick?: () => void
}) {
  return (
    <button
      className={`button button-${variant}`}
      type={type}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </button>
  )
}

export function TextField({
  label,
  value,
  onChange,
  placeholder,
  type = "text",
  error,
  autoFocus = false,
}: {
  label: string
  value: string
  onChange: (value: string) => void
  placeholder: string
  type?: string
  error?: boolean
  autoFocus?: boolean
}) {
  const id = label.toLowerCase().replace(/ /g, "-")
  return (
    <label className="field" htmlFor={id}>
      <span>{label}</span>
      <input
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        type={type}
        aria-invalid={error}
        autoFocus={autoFocus}
      />
    </label>
  )
}
