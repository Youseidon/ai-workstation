"use client";

import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { SettingsGroupPanel } from "@/components/SettingsGroupPanel";
import { GROUP_BLURB, GROUP_TITLE } from "@/lib/settingsGroups";

/**
 * One settings group as a dialog, so the same form can be reached from wherever
 * the settings actually matter — the Agents page, or the pipeline that the
 * policy governs — instead of only from a section on one page.
 *
 * Mount this conditionally (`{open && <SettingsGroupDialog … />}`): it fetches
 * the settings snapshot on mount, and a page that never opens it should not pay
 * for that request.
 */
export function SettingsGroupDialog({
  group,
  onClose,
  onSaved,
}: {
  group: string;
  onClose(): void;
  /** Fired after a successful save, for callers holding derived server state. */
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
      <SettingsGroupPanel group={group} onSaved={onSaved} />
    </Modal>
  );
}
