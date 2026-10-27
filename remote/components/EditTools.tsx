'use client';

import type { EditTool, ToolStates } from '@/lib/app/editController';
import type { Translate } from '@/lib/i18n';
import Icon, { type IconName } from './Icon';

/** One row of the kid's editing tools: icon over a short label, 72 px wide. */
export default function EditTools({ t, states, isOff, onTool }: {
  t: Translate;
  states: ToolStates;
  /** The selected entry is switched off: the toggle reads "turn on". */
  isOff: boolean;
  onTool: (tool: EditTool) => void;
}) {
  const tools: { tool: EditTool; icon: IconName; label: string; danger?: boolean }[] = [
    { tool: 'delete', icon: 'trash', label: t('tools.delete'), danger: true },
    { tool: 'duplicate', icon: 'copy', label: t('tools.duplicate') },
    { tool: 'holdUp', icon: 'plus', label: t('tools.holdUp') },
    { tool: 'holdDown', icon: 'minus', label: t('tools.holdDown') },
    { tool: 'moveLeft', icon: 'arrowLeft', label: t('tools.moveLeft') },
    { tool: 'moveRight', icon: 'arrowRight', label: t('tools.moveRight') },
    { tool: 'off', icon: isOff ? 'eye' : 'eyeOff', label: isOff ? t('tools.on') : t('tools.off') },
    { tool: 'startHere', icon: 'trimStart', label: t('tools.startHere') },
    { tool: 'endHere', icon: 'trimEnd', label: t('tools.endHere') },
    { tool: 'undo', icon: 'undo', label: t('tools.undo') },
  ];
  return (
    <div className="edit-tools" role="toolbar" aria-label={t('tools.label')}>
      {tools.map(({ tool, icon, label, danger }) => (
        <button key={tool} type="button" className={`tool-btn${danger ? ' danger' : ''}`} data-tool={tool} aria-label={label} disabled={!states[tool]} onClick={() => onTool(tool)}>
          <Icon name={icon} />
          <span>{label}</span>
        </button>
      ))}
    </div>
  );
}
