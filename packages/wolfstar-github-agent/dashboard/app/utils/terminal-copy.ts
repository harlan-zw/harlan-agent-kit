import type { TerminalFailure } from '../../../src/terminal-protocol.ts'

/** Canonical terminal failure strings from dashboard/COPY.md. */
export const terminalFailureCopy: Readonly<Record<TerminalFailure, string>> = {
  InvalidRequest: 'The terminal returned invalid data. Reload.',
  AuthenticationRequired: 'Open the pairing link from the terminal host.',
  OriginRefused: 'Open the terminal through its configured address.',
  ProtocolMismatch: 'Update the terminal host before connecting.',
  StaleGeneration: 'The Agent session changed. Reload.',
  WriterBusy: 'Another viewer controls this terminal. Release it there before taking control.',
  StaleWriter: 'Terminal input authority expired. Select Use terminal to reconnect.',
  DuplicateInput: 'The terminal refused repeated input. Check the screen before sending again.',
  SizeLimit: 'Terminal input exceeds the size limit. Paste less text.',
  ProviderUnavailable: 'Install the selected Agent provider on this host.',
  ProjectUnavailable: 'The Project is unavailable on this host. Reload.',
  CapacityUnavailable: 'Shared host capacity is unavailable. Check the host setup.',
  CapacityRefused: 'The host has no capacity for another Agent. Stop a session or wait.',
  LaunchConflict: 'The session request conflicts with saved work. Reload before starting another.',
  OwnershipUnknown: 'The host cannot confirm process ownership. Check the session before starting another.',
  SessionUnavailable: 'The terminal is unavailable. Reload.',
  DeliveryUnknown: 'Input delivery is unknown. Check the terminal before sending again.',
}
