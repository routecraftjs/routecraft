import { Logo } from '@/components/Logo'

interface Node {
  id: string
  label: string
  angle: number
  icon: React.ReactNode
}

const RADIUS = 200
const CENTER_X = 320
const CENTER_Y = 260

const nodes: Node[] = [
  {
    id: 'ai',
    label: 'AI agents',
    angle: -90,
    icon: (
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="h-7 w-7"
        aria-hidden="true"
      >
        <path d="M12 3l1.5 4.5L18 9l-4.5 1.5L12 15l-1.5-4.5L6 9l4.5-1.5L12 3z" />
        <path d="M19 13l.8 2.2L22 16l-2.2.8L19 19l-.8-2.2L16 16l2.2-.8L19 13z" />
      </svg>
    ),
  },
  {
    id: 'mail',
    label: 'Email',
    angle: -30,
    icon: (
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="h-7 w-7"
        aria-hidden="true"
      >
        <rect x="3" y="5" width="18" height="14" rx="2" />
        <path d="m3 7 9 6 9-6" />
      </svg>
    ),
  },
  {
    id: 'cron',
    label: 'Schedules',
    angle: 30,
    icon: (
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="h-7 w-7"
        aria-hidden="true"
      >
        <circle cx="12" cy="12" r="9" />
        <path d="M12 7v5l3 2" />
      </svg>
    ),
  },
  {
    id: 'webhook',
    label: 'Webhooks',
    angle: 90,
    icon: (
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="h-7 w-7"
        aria-hidden="true"
      >
        <path d="M13 2 3 14h7l-1 8 10-12h-7l1-8z" />
      </svg>
    ),
  },
  {
    id: 'http',
    label: 'APIs',
    angle: 150,
    icon: (
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="h-7 w-7"
        aria-hidden="true"
      >
        <circle cx="12" cy="12" r="9" />
        <path d="M3 12h18" />
        <path d="M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" />
      </svg>
    ),
  },
  {
    id: 'files',
    label: 'Files & DBs',
    angle: 210,
    icon: (
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="h-7 w-7"
        aria-hidden="true"
      >
        <ellipse cx="12" cy="5" rx="8" ry="3" />
        <path d="M4 5v6c0 1.7 3.6 3 8 3s8-1.3 8-3V5" />
        <path d="M4 11v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6" />
      </svg>
    ),
  },
]

function nodePosition(angle: number) {
  const rad = (angle * Math.PI) / 180
  return {
    x: CENTER_X + RADIUS * Math.cos(rad),
    y: CENTER_Y + RADIUS * Math.sin(rad),
  }
}

export function DataFlowAnimation({ className }: { className?: string }) {
  return (
    <div className={className}>
      <svg
        viewBox="0 0 640 520"
        className="h-auto w-full"
        role="img"
        aria-label="Data flowing between AI agents, email, schedules, webhooks, APIs, and files through Routecraft at the center"
      >
        <defs>
          <radialGradient id="centerGlow" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="rgb(14, 165, 233)" stopOpacity="0.35" />
            <stop offset="100%" stopColor="rgb(14, 165, 233)" stopOpacity="0" />
          </radialGradient>
          <linearGradient
            id="lineGradient"
            x1="0%"
            y1="0%"
            x2="100%"
            y2="0%"
          >
            <stop offset="0%" stopColor="rgb(148, 163, 184)" stopOpacity="0" />
            <stop
              offset="50%"
              stopColor="rgb(148, 163, 184)"
              stopOpacity="0.65"
            />
            <stop offset="100%" stopColor="rgb(148, 163, 184)" stopOpacity="0" />
          </linearGradient>
        </defs>

        {/* Soft glow behind center */}
        <circle cx={CENTER_X} cy={CENTER_Y} r="170" fill="url(#centerGlow)" />

        {/* Connection lines + traveling dots */}
        {nodes.map((node, i) => {
          const pos = nodePosition(node.angle)
          const pathId = `path-${node.id}`
          const reverseId = `path-${node.id}-reverse`
          const delay = (i * 0.5).toFixed(2)
          return (
            <g key={node.id}>
              <path
                id={pathId}
                d={`M ${CENTER_X} ${CENTER_Y} L ${pos.x} ${pos.y}`}
                className="stroke-sky-400/40 dark:stroke-sky-500/30"
                strokeWidth="1.5"
                fill="none"
              />
              <path
                id={reverseId}
                d={`M ${pos.x} ${pos.y} L ${CENTER_X} ${CENTER_Y}`}
                className="invisible"
                fill="none"
              />
              {/* Outbound dot (center -> node) */}
              <circle
                r="4"
                className="fill-sky-500 dark:fill-sky-400"
              >
                <animateMotion
                  dur="3.2s"
                  repeatCount="indefinite"
                  begin={`${delay}s`}
                >
                  <mpath href={`#${pathId}`} />
                </animateMotion>
                <animate
                  attributeName="opacity"
                  values="0;1;1;0"
                  keyTimes="0;0.1;0.85;1"
                  dur="3.2s"
                  repeatCount="indefinite"
                  begin={`${delay}s`}
                />
              </circle>
              {/* Inbound dot (node -> center) */}
              <circle
                r="3"
                className="fill-indigo-400 dark:fill-indigo-300"
              >
                <animateMotion
                  dur="3.2s"
                  repeatCount="indefinite"
                  begin={`${(parseFloat(delay) + 1.6).toFixed(2)}s`}
                >
                  <mpath href={`#${reverseId}`} />
                </animateMotion>
                <animate
                  attributeName="opacity"
                  values="0;1;1;0"
                  keyTimes="0;0.1;0.85;1"
                  dur="3.2s"
                  repeatCount="indefinite"
                  begin={`${(parseFloat(delay) + 1.6).toFixed(2)}s`}
                />
              </circle>
            </g>
          )
        })}

        {/* Outer nodes */}
        {nodes.map((node) => {
          const pos = nodePosition(node.angle)
          return (
            <g
              key={`node-${node.id}`}
              transform={`translate(${pos.x - 36}, ${pos.y - 36})`}
            >
              <circle
                cx="36"
                cy="36"
                r="34"
                className="fill-white stroke-gray-200 dark:fill-gray-900 dark:stroke-gray-700"
                strokeWidth="1"
              />
              <foreignObject x="14" y="14" width="44" height="44">
                <div className="flex h-full w-full items-center justify-center text-gray-700 dark:text-gray-300">
                  {node.icon}
                </div>
              </foreignObject>
              <text
                x="36"
                y="92"
                textAnchor="middle"
                className="fill-gray-600 font-display text-[11px] dark:fill-gray-400"
              >
                {node.label}
              </text>
            </g>
          )
        })}

        {/* Center: Routecraft */}
        <g transform={`translate(${CENTER_X - 56}, ${CENTER_Y - 56})`}>
          <circle
            cx="56"
            cy="56"
            r="54"
            className="fill-white stroke-sky-200 dark:fill-gray-900 dark:stroke-sky-500/40"
            strokeWidth="1.5"
          />
          <circle
            cx="56"
            cy="56"
            r="48"
            className="fill-sky-50 dark:fill-sky-500/5"
          >
            <animate
              attributeName="r"
              values="46;52;46"
              dur="3.2s"
              repeatCount="indefinite"
            />
            <animate
              attributeName="opacity"
              values="0.4;0.8;0.4"
              dur="3.2s"
              repeatCount="indefinite"
            />
          </circle>
          <foreignObject x="20" y="20" width="72" height="72">
            <div className="flex h-full w-full items-center justify-center">
              <Logo className="h-12 w-12" />
            </div>
          </foreignObject>
          <text
            x="56"
            y="128"
            textAnchor="middle"
            className="fill-gray-900 font-display text-sm font-medium dark:fill-white"
          >
            Routecraft
          </text>
        </g>
      </svg>
    </div>
  )
}
