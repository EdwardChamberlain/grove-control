import { useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';

import type { AMSTray, SlotPresetMapping } from '../api/client';
import { AssignSpoolModal } from '../components/AssignSpoolModal';
import { ConfigureAmsSlotModal } from '../components/ConfigureAmsSlotModal';
import { LinkSpoolModal } from '../components/LinkSpoolModal';
import { AmsSlotControl } from '../components/printer/AmsCardParts';
import { buildAmsInventoryConfig, type AmsSlotModel } from '../components/printer/amsSlotModel';
import { getAmsSlotExtruderId } from '../utils/amsHelpers';

interface LinkSlotModalState {
  tagUid: string;
  trayUuid: string;
  amsId: number;
  trayId: number;
}

interface AssignSlotModalState {
  amsId: number;
  trayId: number;
  trayInfo: {
    type: string;
    material?: string;
    profile?: string;
    color: string;
    location: string;
  };
}

interface ConfigureSlotModalState {
  amsId: number;
  trayId: number;
  trayCount: number;
  trayType?: string;
  trayColor?: string;
  traySubBrands?: string;
  trayInfoIdx?: string;
  extruderId?: number;
  caliIdx?: number | null;
  savedPresetId?: string;
}

export interface AmsSlotBindingOptions {
  amsId: number;
  trayId: number;
  trayCount: number;
  tray?: AMSTray;
  slotPreset?: SlotPresetMapping;
  location: string;
  emptyLocation?: string;
  model: AmsSlotModel;
}

interface AmsSlotControllerOptions {
  printerId: number;
  printerModel?: string;
  spoolmanEnabled: boolean;
  spoolmanUrl?: string | null;
  spoolmanSyncMode?: string | null;
  canConfigure: boolean;
  isDualNozzle: boolean;
  amsExtruderMap?: Record<string, number>;
  onUnlinkSpool: (spoolId: number) => void;
  onUnassignSpoolmanSpool?: (spoolId: number) => void;
  onUnassignInventorySpool?: (amsId: number, trayId: number) => void;
}

export interface AmsSlotController {
  printerId: number;
  printerModel?: string;
  spoolmanEnabled: boolean;
  linkModal: LinkSlotModalState | null;
  assignModal: AssignSlotModalState | null;
  configureModal: ConfigureSlotModalState | null;
  closeLinkModal: () => void;
  closeAssignModal: () => void;
  closeConfigureModal: () => void;
  getBindings: (slot: AmsSlotBindingOptions) => {
    spoolman?: Parameters<typeof AmsSlotControl>[0]['spoolman'];
    inventory?: Parameters<typeof AmsSlotControl>[0]['inventory'];
    configureSlot: NonNullable<Parameters<typeof AmsSlotControl>[0]['configureSlot']>;
    onAssignSpool?: () => void;
  };
}

/** Owns all link/assign/configure modal state and derives identical hover-card wiring for every slot layout. */
export function useAmsSlotController(options: AmsSlotControllerOptions): AmsSlotController {
  const [linkModal, setLinkModal] = useState<LinkSlotModalState | null>(null);
  const [assignModal, setAssignModal] = useState<AssignSlotModalState | null>(null);
  const [configureModal, setConfigureModal] = useState<ConfigureSlotModalState | null>(null);

  const getBindings = (slot: AmsSlotBindingOptions) => {
    const { amsId, trayId, trayCount, tray, slotPreset, location, emptyLocation, model } = slot;
    const filament = model.filamentData;
    const openAssign = () => setAssignModal({
      amsId,
      trayId,
      trayInfo: filament ? {
        type: tray?.tray_type || filament.profile,
        material: tray?.tray_type ?? undefined,
        profile: filament.profile,
        color: filament.colorHex || '',
        location,
      } : { type: '', profile: '', color: '', location: emptyLocation ?? location },
    });
    const openConfigure = () => setConfigureModal({
      amsId,
      trayId,
      trayCount,
      extruderId: getAmsSlotExtruderId({
        amsId,
        trayId,
        isDualNozzle: options.isDualNozzle,
        amsExtruderMap: options.amsExtruderMap,
      }),
      ...(filament ? {
        trayType: tray?.tray_type || undefined,
        trayColor: tray?.tray_color || undefined,
        traySubBrands: tray?.tray_sub_brands || undefined,
        trayInfoIdx: tray?.tray_info_idx || undefined,
        caliIdx: tray?.cali_idx,
        savedPresetId: slotPreset?.preset_id,
      } : {}),
    });

    return {
      spoolman: filament ? {
        enabled: options.spoolmanEnabled,
        linkedSpoolId: model.spoolmanAssignment?.spoolman_spool_id ?? model.linkedSpool?.id,
        spoolmanUrl: options.spoolmanUrl,
        syncMode: options.spoolmanSyncMode,
        onLinkSpool: model.canLinkSpool ? () => {
          const linkTag = (filament.trayUuid || filament.tagUid || model.trayTag || '').toUpperCase();
          setLinkModal({
            tagUid: filament.tagUid || linkTag,
            trayUuid: filament.trayUuid || '',
            amsId,
            trayId,
          });
        } : undefined,
        onUnlinkSpool: model.linkedSpool?.id
          ? () => options.onUnlinkSpool(model.linkedSpool!.id)
          : undefined,
      } : undefined,
      inventory: buildAmsInventoryConfig(model, {
        onAssignSpool: openAssign,
        onUnassignSpoolmanSpool: options.onUnassignSpoolmanSpool,
        onUnassignInventorySpool: () => options.onUnassignInventorySpool?.(amsId, trayId),
      }),
      configureSlot: { enabled: options.canConfigure, onConfigure: openConfigure },
      onAssignSpool: filament ? undefined : openAssign,
    };
  };

  return {
    printerId: options.printerId,
    printerModel: options.printerModel,
    spoolmanEnabled: options.spoolmanEnabled,
    linkModal,
    assignModal,
    configureModal,
    closeLinkModal: () => setLinkModal(null),
    closeAssignModal: () => setAssignModal(null),
    closeConfigureModal: () => setConfigureModal(null),
    getBindings,
  };
}

export function AmsSlot({
  controller,
  slot,
  emptyKind,
  actions,
  children,
}: {
  controller: AmsSlotController;
  slot: AmsSlotBindingOptions;
  emptyKind?: 'physical' | 'reset' | null;
  actions?: ReactNode;
  children: ReactNode | ((bindings: ReturnType<AmsSlotController['getBindings']>) => ReactNode);
}) {
  const bindings = controller.getBindings(slot);
  return (
    <AmsSlotControl
      filament={slot.model.filamentData}
      emptyKind={emptyKind}
      actions={actions}
      {...bindings}
    >
      {typeof children === 'function' ? children(bindings) : children}
    </AmsSlotControl>
  );
}

export function AmsSlotControllerModals({ controller }: { controller: AmsSlotController }) {
  const queryClient = useQueryClient();
  return (
    <>
      {controller.linkModal && (
        <LinkSpoolModal
          isOpen
          onClose={controller.closeLinkModal}
          tagUid={controller.linkModal.tagUid}
          trayUuid={controller.linkModal.trayUuid}
          printerId={controller.printerId}
          amsId={controller.linkModal.amsId}
          trayId={controller.linkModal.trayId}
        />
      )}
      {controller.assignModal && (
        <AssignSpoolModal
          isOpen
          onClose={controller.closeAssignModal}
          printerId={controller.printerId}
          amsId={controller.assignModal.amsId}
          trayId={controller.assignModal.trayId}
          trayInfo={controller.assignModal.trayInfo}
          spoolmanEnabled={controller.spoolmanEnabled}
        />
      )}
      {controller.configureModal && (
        <ConfigureAmsSlotModal
          isOpen
          onClose={controller.closeConfigureModal}
          printerId={controller.printerId}
          slotInfo={controller.configureModal}
          printerModel={controller.printerModel}
          onSuccess={() => {
            queryClient.invalidateQueries({ queryKey: ['slotPresets', controller.printerId] });
            queryClient.invalidateQueries({ queryKey: ['printerStatus', controller.printerId] });
          }}
        />
      )}
    </>
  );
}
