"use client";

import type { SettingsDraftState } from "@/features/settings/lib/drafts";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { SettingsGroupPanel } from "@/features/settings/components/SettingsGroupPanel";
import {
  GROUP_BLURB,
  GROUP_TITLE,
} from "@/features/settings/lib/settingsGroups";

export function SettingsGroupDialog({
  group,
  onClose,
  onSaved,
  draftState,
  disabled,
}: {
  group: string;
  draftState?: SettingsDraftState;
  disabled?: boolean;
  onClose(): void;
  onSaved?(): void;
}) {
  const title = GROUP_TITLE[group] ?? group;
  const blurb = GROUP_BLURB[group];

  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      title={title}
      description={blurb}
      footer={
        <Button variant="ghost" onClick={onClose}>
          Close
        </Button>
      }
    >
      <SettingsGroupPanel
        key={group}
        group={group}
        onSaved={onSaved}
        header={false}
        compact
        draftState={draftState}
        disabled={disabled}
      />
    </Modal>
  );
}
