import type { Meta, StoryObj } from "@storybook/react-vite";
import type { ReactNode } from "react";
import {
  ClaudeAccountRotationHistory,
  type ClaudeAccountAttempt,
} from "@/components/ClaudeAccountRotationHistory";

// ELI-245: rotation-history surface for the ELI-243 multi-account failover
// audit trail (resultJson.claudeAccountAttempts). Three cases mirror the
// acceptance criteria: single-entry success, rotation-then-success, exhaustion.

const ONE_ENTRY_SUCCESS: ClaudeAccountAttempt[] = [
  { attemptIndex: 0, label: "primary", outcome: "success", advancedTo: null },
];

const TWO_ENTRY_ROTATION: ClaudeAccountAttempt[] = [
  {
    attemptIndex: 0,
    label: "primary",
    outcome: "auth_required",
    errorMessage: "Not logged in",
    advancedTo: "secondary",
  },
  { attemptIndex: 1, label: "secondary", outcome: "success", advancedTo: null },
];

const THREE_ENTRY_EXHAUSTION: ClaudeAccountAttempt[] = [
  {
    attemptIndex: 0,
    label: "primary",
    outcome: "auth_required",
    errorMessage: "Not logged in",
    advancedTo: "secondary",
  },
  {
    attemptIndex: 1,
    label: "secondary",
    outcome: "config_dir_missing",
    errorMessage: "Config directory not found: /home/agent/.claude-secondary",
    advancedTo: "tertiary",
  },
  {
    attemptIndex: 2,
    label: "tertiary",
    outcome: "auth_required",
    errorMessage: "Not logged in",
    advancedTo: null,
  },
];

function StoryFrame({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return (
    <main className="min-h-screen bg-background p-4 text-foreground sm:p-8">
      <div className="mx-auto max-w-2xl space-y-5">
        <header>
          <div className="text-xs font-medium uppercase tracking-[0.2em] text-muted-foreground">
            Claude account rotation
          </div>
          <h1 className="mt-1 text-2xl font-semibold">{title}</h1>
          {description ? <p className="mt-2 text-sm text-muted-foreground">{description}</p> : null}
        </header>
        {children}
      </div>
    </main>
  );
}

// Stories drive the component through `render` with explicit fixtures. The meta
// is bound to a no-required-prop gallery wrapper (matching the convention in the
// other stories, e.g. source-issue-recovery) so individual stories need no `args`.
function RotationHistoryGallery() {
  return (
    <StoryFrame
      title="Rotation history — all cases"
      description="One-entry success, rotation-then-success, and exhaustion side by side."
    >
      <div className="space-y-4">
        <ClaudeAccountRotationHistory attempts={ONE_ENTRY_SUCCESS} defaultOpen />
        <ClaudeAccountRotationHistory attempts={TWO_ENTRY_ROTATION} defaultOpen />
        <ClaudeAccountRotationHistory attempts={THREE_ENTRY_EXHAUSTION} defaultOpen />
      </div>
    </StoryFrame>
  );
}

const meta = {
  title: "Agents/Claude account rotation history",
  component: RotationHistoryGallery,
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof RotationHistoryGallery>;

export default meta;

type Story = StoryObj<typeof meta>;

export const SingleEntrySuccess: Story = {
  render: () => (
    <StoryFrame
      title="Single account — success"
      description="One configured account that succeeded on the first attempt; no rotation occurred."
    >
      <ClaudeAccountRotationHistory attempts={ONE_ENTRY_SUCCESS} defaultOpen />
    </StoryFrame>
  ),
};

export const RotationThenSuccess: Story = {
  render: () => (
    <StoryFrame
      title="Rotation, then success"
      description="The primary account required login, so the adapter advanced to the secondary account, which succeeded."
    >
      <ClaudeAccountRotationHistory attempts={TWO_ENTRY_ROTATION} defaultOpen />
    </StoryFrame>
  ),
};

export const ExhaustionTerminalAuthRequired: Story = {
  render: () => (
    <StoryFrame
      title="Exhaustion — all accounts failed"
      description="Every configured account failed an auth-class check; the run terminates with claude_auth_required. Expanded by default so the failure detail is visible."
    >
      <ClaudeAccountRotationHistory attempts={THREE_ENTRY_EXHAUSTION} defaultOpen />
    </StoryFrame>
  ),
};

export const CollapsedByDefault: Story = {
  render: () => (
    <StoryFrame
      title="Collapsed by default"
      description="Default presentation inside a run card: collapsed, expand on click."
    >
      <ClaudeAccountRotationHistory attempts={TWO_ENTRY_ROTATION} />
    </StoryFrame>
  ),
};
