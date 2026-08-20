import React from 'react'
import { Server, ServerOff } from 'lucide-react'

import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useAppStore } from '@/store'
import { parseExecutionHostId, type ExecutionHostId } from '../../../../shared/execution-host'
import { translate } from '@/i18n/i18n'

type NoticeHostGlyphProps = {
  hostId: ExecutionHostId
  hostLabel: string
}

/**
 * The host indicator for a discovery-notice row.
 *
 * Deliberately the same glyph and "Project on …" tooltip worktree cards use
 * (worktree-card-header.tsx), so one project's rows read the same way wherever
 * they appear. Local hosts get none, matching the cards.
 */
export default function NoticeHostGlyph({
  hostId,
  hostLabel
}: NoticeHostGlyphProps): React.JSX.Element | null {
  const host = parseExecutionHostId(hostId)
  const isDisconnected = useAppStore((s) => {
    if (host?.kind !== 'runtime') {
      return false
    }
    return !s.runtimeStatusByEnvironmentId.get(host.environmentId)?.status
  })

  if (!host || host.kind === 'local') {
    return null
  }

  const tooltip = isDisconnected
    ? translate(
        'auto.components.sidebar.NoticeHostGlyph.hostDisconnected',
        '{{hostName}} disconnected',
        { hostName: hostLabel }
      )
    : host.kind === 'ssh'
      ? translate(
          'auto.components.sidebar.NoticeHostGlyph.sshHostProject',
          'Project on SSH host {{hostName}}',
          { hostName: hostLabel }
        )
      : translate(
          'auto.components.sidebar.NoticeHostGlyph.runtimeHostProject',
          'Project on {{hostName}}',
          { hostName: hostLabel }
        )

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex shrink-0 items-center" data-notice-host-kind={host.kind}>
          {isDisconnected ? (
            <ServerOff className="size-3 text-destructive" aria-hidden="true" />
          ) : (
            <Server className="size-3 text-muted-foreground" aria-hidden="true" />
          )}
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={4}>
        {tooltip}
      </TooltipContent>
    </Tooltip>
  )
}
