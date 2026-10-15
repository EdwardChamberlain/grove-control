import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { AuthProvider, useAuth } from '../contexts/AuthContext';
import { ColorCatalogProvider } from '../contexts/ColorCatalogContext';
import { SliceJobTrackerProvider } from '../contexts/SliceJobTrackerContext';
import { ThemeProvider } from '../contexts/ThemeContext';
import { api, ApiError, clearMemoryAuthTokenOverride, getAuthToken, setAuthToken } from '../api/client';
import type { LibraryFile, UserResponse } from '../api/client';
import { PrintModal } from '../components/PrintModal';
import { LoginPage } from './LoginPage';

const ORCA_PROTOCOL_VERSION = 1;

type BridgeMessage = Record<string, unknown> & {
  type: string;
  protocol_version: number;
  request_id: string;
};

interface PrintInitialization extends BridgeMessage {
  type: 'initialize';
  mode: 'print';
  access_token: string;
  expected_user_id: number;
  library_file_id: number;
  filename: string;
  plate_id?: number | null;
}

declare global {
  interface Window {
    orca?: {
      postMessage: (payload: BridgeMessage) => void;
      onMessage: (handler: (payload: unknown) => void) => void;
    };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isJwt(value: string): boolean {
  return /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value);
}

function isBridgeEnvelope(value: unknown, requestId: string): value is BridgeMessage {
  return isRecord(value)
    && value.request_id === requestId
    && value.protocol_version === ORCA_PROTOCOL_VERSION
    && typeof value.type === 'string';
}

function messageFor(requestId: string, type: string, fields: Record<string, unknown> = {}): BridgeMessage {
  return {
    ...fields,
    type,
    protocol_version: ORCA_PROTOCOL_VERSION,
    request_id: requestId,
  };
}

function postToOrca(message: BridgeMessage) {
  window.orca?.postMessage(message);
}

function postToPrintParent(message: BridgeMessage) {
  // Orca's local wrapper has an opaque file: origin. The parent validates the
  // Grove origin and iframe source before forwarding this receipt to native.
  window.parent.postMessage(message, '*');
}

function IntegrationFrame({ children }: { children: React.ReactNode }) {
  return (
    <main className="min-h-screen bg-bambu-dark-primary text-white">
      {children}
    </main>
  );
}

function StatusMessage({ children }: { children: React.ReactNode }) {
  return (
    <IntegrationFrame>
      <div className="min-h-screen flex items-center justify-center p-6 text-center">
        <p className="max-w-xl text-sm text-bambu-gray">{children}</p>
      </div>
    </IntegrationFrame>
  );
}

function ConnectMode({ requestId }: { requestId: string }) {
  const location = useLocation();
  const navigate = useNavigate();
  const { authEnabled, loading, user } = useAuth();
  const [initialized, setInitialized] = useState(false);
  const [terminalMessage, setTerminalMessage] = useState<string | null>(null);
  const terminalRef = useRef(false);

  const sendTerminal = useCallback((type: string, fields: Record<string, unknown> = {}) => {
    if (terminalRef.current) return;
    terminalRef.current = true;
    postToOrca(messageFor(requestId, type, fields));
    if (type === 'error') {
      setTerminalMessage(typeof fields.message === 'string' ? fields.message : 'Grove sign-in could not be completed.');
    } else if (type === 'authenticated') {
      setTerminalMessage('Grove account connected. You can return to Orca.');
    } else {
      setTerminalMessage('Grove connection cancelled.');
    }
  }, [requestId]);

  useEffect(() => {
    const bridge = window.orca;
    if (!bridge) {
      setTerminalMessage('Open this page from Orca to connect a Grove account.');
      return;
    }

    bridge.onMessage((payload) => {
      if (!isBridgeEnvelope(payload, requestId) || terminalRef.current) return;
      if (payload.type === 'initialize' && payload.mode === 'connect') {
        setInitialized(true);
      } else if (payload.type === 'cancel_requested') {
        sendTerminal('cancelled');
      }
    });
    postToOrca(messageFor(requestId, 'ready'));
  }, [requestId, sendTerminal]);

  const state = location.state as { from?: { pathname?: string; search?: string } } | null;
  const hasReturnTarget = state?.from?.pathname === location.pathname
    && (state.from.search ?? '') === location.search;

  useEffect(() => {
    if (loading || !authEnabled || user || terminalRef.current || hasReturnTarget) return;
    navigate(`${location.pathname}${location.search}`, {
      replace: true,
      state: { from: { pathname: location.pathname, search: location.search } },
    });
  }, [authEnabled, hasReturnTarget, loading, location.pathname, location.search, navigate, user]);

  useEffect(() => {
    if (loading || terminalRef.current) return;
    if (!authEnabled) {
      sendTerminal('error', { message: 'Grove user authentication must be enabled to connect Orca.' });
      return;
    }
    if (!initialized || !user) return;

    const token = getAuthToken();
    if (!token || !isJwt(token) || !user.is_active || !isPositiveInteger(user.id)) {
      sendTerminal('error', { message: 'Sign in to Grove with an active user account to connect Orca.' });
      return;
    }
    sendTerminal('authenticated', { access_token: token });
  }, [authEnabled, initialized, loading, sendTerminal, user]);

  if (terminalMessage) return <StatusMessage>{terminalMessage}</StatusMessage>;
  if (!initialized || loading || (!authEnabled && !terminalRef.current)) {
    return <StatusMessage>Connecting to Grove Control…</StatusMessage>;
  }
  if (!user) return hasReturnTarget ? <LoginPage /> : <StatusMessage>Preparing Grove sign-in…</StatusMessage>;
  return <StatusMessage>Finishing Grove connection…</StatusMessage>;
}

function ConnectApplication({ requestId }: { requestId: string }) {
  return (
    <AuthProvider>
      <ThemeProvider>
        <ConnectMode requestId={requestId} />
      </ThemeProvider>
    </AuthProvider>
  );
}

function PrintMode({ requestId }: { requestId: string }) {
  const [initialization, setInitialization] = useState<PrintInitialization | null>(null);
  const [verified, setVerified] = useState<{ user: UserResponse; file: LibraryFile } | null>(null);
  const [phase, setPhase] = useState<'waiting' | 'verifying' | 'ready' | 'terminal'>('waiting');
  const [statusMessage, setStatusMessage] = useState('Waiting for Orca to initialize the print form…');
  const [cancelRequested, setCancelRequested] = useState(false);
  const terminalRef = useRef(false);
  const submittingRef = useRef(false);
  const cancelRequestedRef = useRef(false);
  const initRef = useRef<PrintInitialization | null>(null);

  const releaseSession = useCallback(() => {
    clearMemoryAuthTokenOverride();
  }, []);

  const sendTerminal = useCallback((type: string, fields: Record<string, unknown> = {}) => {
    if (terminalRef.current) return;
    terminalRef.current = true;
    postToPrintParent(messageFor(requestId, type, fields));
    setPhase('terminal');
    if (type === 'submitted') {
      setStatusMessage('Print jobs added to the Grove queue.');
    } else if (type === 'partial') {
      setStatusMessage('Some print requests were added. Check the Grove queue for details.');
    } else if (type === 'cancelled') {
      setStatusMessage('Print request cancelled. The uploaded file remains in File Manager.');
    } else if (type === 'session_expired') {
      setStatusMessage('Your Grove session expired. Reconnect your Grove account in Orca.');
    } else {
      setStatusMessage(typeof fields.message === 'string' ? fields.message : 'The print request could not be confirmed. Check Grove before trying again.');
    }
  }, [requestId]);

  useEffect(() => {
    if (phase !== 'terminal') return;
    // Let the shared modal finish its success callbacks and cache invalidation
    // before restoring any browser account that was present before Orca.
    const timer = window.setTimeout(releaseSession, 0);
    return () => window.clearTimeout(timer);
  }, [phase, releaseSession]);

  const sendPrintError = useCallback((message: string, extra: Record<string, unknown> = {}) => {
    const current = initRef.current;
    sendTerminal('error', {
      message,
      ...(current ? { user_id: current.expected_user_id, library_file_id: current.library_file_id } : {}),
      queue_item_ids: [],
      ...extra,
    });
  }, [sendTerminal]);

  const verifyInitialization = useCallback(async (incoming: PrintInitialization) => {
    setPhase('verifying');
    setStatusMessage('Verifying your Grove account and uploaded file…');
    setAuthToken(incoming.access_token, 'memory');

    try {
      const authStatus = await api.getAuthStatus();
      if (terminalRef.current) return;
      if (!authStatus.auth_enabled) {
        sendPrintError('Grove user authentication must be enabled for Orca printing.');
        return;
      }

      const user = await api.getCurrentUser();
      if (terminalRef.current) return;
      if (!user.is_active || user.id !== incoming.expected_user_id) {
        sendTerminal('session_expired', {
          user_id: incoming.expected_user_id,
          library_file_id: incoming.library_file_id,
        });
        return;
      }

      const isAdmin = user.is_admin;
      const canCreateQueue = isAdmin || user.permissions.includes('queue:create');
      const canReadLibrary = isAdmin
        || user.permissions.includes('library:read_own')
        || user.permissions.includes('library:read_all');
      if (!canCreateQueue || !canReadLibrary) {
        sendPrintError('Your Grove account is missing permission to read this file or create queue items.');
        return;
      }

      const file = await api.getLibraryFile(incoming.library_file_id);
      if (terminalRef.current) return;
      if (file.created_by_id !== user.id) {
        sendPrintError('The uploaded file does not belong to the connected Grove account.');
        return;
      }

      if (incoming.plate_id != null) {
        const plateData = await api.getLibraryFilePlates(incoming.library_file_id);
        if (terminalRef.current) return;
        if (!plateData.plates.some((plate) => plate.index === incoming.plate_id)) {
          sendPrintError(`Plate ${incoming.plate_id} is not available in the uploaded file.`);
          return;
        }
      }

      if (terminalRef.current) return;
      setVerified({ user, file });
      setPhase('ready');
    } catch (error) {
      if (terminalRef.current) return;
      if (error instanceof ApiError && error.status === 401) {
        sendTerminal('session_expired', {
          user_id: incoming.expected_user_id,
          library_file_id: incoming.library_file_id,
        });
        return;
      }
      sendPrintError(error instanceof ApiError && error.status === 403
        ? 'Your Grove account is missing permission to use this file or create queue items.'
        : 'Grove could not verify the session or uploaded file. Reconnect and try again.');
    }
  }, [sendPrintError, sendTerminal]);

  useEffect(() => {
    const handleMessage = (event: MessageEvent<unknown>) => {
      if (event.source !== window.parent || !isBridgeEnvelope(event.data, requestId)) return;
      const payload = event.data;
      if (terminalRef.current) return;

      if (payload.type === 'cancel_requested') {
        if (submittingRef.current) {
          cancelRequestedRef.current = true;
          setCancelRequested(true);
        } else {
          sendTerminal('cancelled', {
            ...(initRef.current ? {
              user_id: initRef.current.expected_user_id,
              library_file_id: initRef.current.library_file_id,
            } : {}),
            queue_item_ids: [],
          });
        }
        return;
      }

      if (payload.type !== 'initialize' || payload.mode !== 'print' || initRef.current) return;
      const plateId = payload.plate_id;
      const validPlateId = plateId === undefined || plateId === null || isPositiveInteger(plateId);
      if (
        typeof payload.access_token !== 'string'
        || !payload.access_token
        || !isPositiveInteger(payload.expected_user_id)
        || !isPositiveInteger(payload.library_file_id)
        || typeof payload.filename !== 'string'
        || !validPlateId
      ) {
        sendPrintError('Orca sent invalid print initialization data.');
        return;
      }

      const incoming = payload as PrintInitialization;
      initRef.current = incoming;
      setInitialization(incoming);
      void verifyInitialization(incoming);
    };

    // Register the receiver before ready: the native host sends initialize
    // immediately after observing this event.
    window.addEventListener('message', handleMessage);
    postToPrintParent(messageFor(requestId, 'ready'));
    return () => {
      window.removeEventListener('message', handleMessage);
      releaseSession();
    };
  }, [releaseSession, requestId, sendPrintError, sendTerminal, verifyInitialization]);

  const handleModalResult = useCallback((result: {
    outcome: 'success' | 'partial' | 'uncertain' | 'failed' | 'cancelled' | 'session_expired';
    queueItemIds: number[];
    message?: string;
  }) => {
    const current = initRef.current;
    const receipt = current ? {
      user_id: current.expected_user_id,
      library_file_id: current.library_file_id,
      queue_item_ids: result.queueItemIds,
    } : { queue_item_ids: result.queueItemIds };

    if (result.outcome === 'success') {
      sendTerminal('submitted', receipt);
    } else if (result.outcome === 'partial') {
      sendTerminal('partial', receipt);
    } else if (result.outcome === 'cancelled') {
      sendTerminal('cancelled', receipt);
    } else if (result.outcome === 'session_expired') {
      sendTerminal('session_expired', receipt);
    } else {
      sendTerminal('error', {
        ...receipt,
        message: result.message ?? (result.outcome === 'uncertain'
          ? 'Grove could not confirm whether every queue request was accepted. Check the Grove queue before trying again.'
          : 'Grove could not create the requested queue items.'),
        outcome: result.outcome === 'uncertain' ? 'uncertain' : 'failed',
      });
    }
  }, [sendTerminal]);

  const handleModalClose = useCallback(() => {
    if (submittingRef.current) {
      cancelRequestedRef.current = true;
      setCancelRequested(true);
      return;
    }
    const current = initRef.current;
    sendTerminal('cancelled', {
      ...(current ? { user_id: current.expected_user_id, library_file_id: current.library_file_id } : {}),
      queue_item_ids: [],
    });
  }, [sendTerminal]);

  if (phase === 'terminal') return <StatusMessage>{statusMessage}</StatusMessage>;
  if (!initialization || !verified || phase !== 'ready') return <StatusMessage>{statusMessage}</StatusMessage>;

  return (
    <AuthProvider>
      <VerifiedPrintProviders
        initialization={initialization}
        verifiedUser={verified.user}
        filename={verified.file.filename || initialization.filename}
        cancelRequested={cancelRequested}
        cancelRequestedRef={cancelRequestedRef}
        onSubmissionStateChange={(active) => { submittingRef.current = active; }}
        onResult={handleModalResult}
        onClose={handleModalClose}
        onSessionExpired={() => sendTerminal('session_expired', {
          user_id: initialization.expected_user_id,
          library_file_id: initialization.library_file_id,
        })}
        onPermissionError={(message) => sendPrintError(message)}
      />
    </AuthProvider>
  );
}

function VerifiedPrintProviders({
  initialization,
  verifiedUser,
  filename,
  cancelRequested,
  cancelRequestedRef,
  onSubmissionStateChange,
  onResult,
  onClose,
  onSessionExpired,
  onPermissionError,
}: {
  initialization: PrintInitialization;
  verifiedUser: UserResponse;
  filename: string;
  cancelRequested: boolean;
  cancelRequestedRef: { current: boolean };
  onSubmissionStateChange: (active: boolean) => void;
  onResult: (result: {
    outcome: 'success' | 'partial' | 'uncertain' | 'failed' | 'cancelled' | 'session_expired';
    queueItemIds: number[];
    message?: string;
  }) => void;
  onClose: () => void;
  onSessionExpired: () => void;
  onPermissionError: (message: string) => void;
}) {
  const { authEnabled, loading, user, hasPermission } = useAuth();
  const reportedRef = useRef(false);
  const [submissionActive, setSubmissionActive] = useState(false);
  const isAdmin = user?.is_admin ?? false;
  const notifySubmissionStateChange = useCallback((active: boolean) => {
    setSubmissionActive(active);
    onSubmissionStateChange(active);
  }, [onSubmissionStateChange]);

  useEffect(() => {
    if (loading || reportedRef.current) return;
    if (!authEnabled || !user || user.id !== initialization.expected_user_id || !user.is_active) {
      if (submissionActive) return;
      reportedRef.current = true;
      onSessionExpired();
      return;
    }
    const canReadLibrary = isAdmin || hasPermission('library:read_own') || hasPermission('library:read_all');
    if (!(isAdmin || hasPermission('queue:create')) || !canReadLibrary) {
      if (submissionActive) return;
      reportedRef.current = true;
      onPermissionError('Your Grove account is missing permission to use this file or create queue items.');
    }
  }, [authEnabled, hasPermission, initialization.expected_user_id, isAdmin, loading, onPermissionError, onSessionExpired, submissionActive, user]);

  if (loading || !authEnabled || !user || user.id !== verifiedUser.id || reportedRef.current) {
    return <StatusMessage>Your Grove session is being checked…</StatusMessage>;
  }

  return (
    <ThemeProvider>
      <ColorCatalogProvider>
        <SliceJobTrackerProvider>
          <PrintModal
            mode="create"
            libraryFileId={initialization.library_file_id}
            archiveName={filename}
            initialPlateId={initialization.plate_id ?? undefined}
            cleanupLibraryAfterDispatch
            cancelRequested={cancelRequested}
            cancelRequestedRef={cancelRequestedRef}
            onSubmissionStateChange={notifySubmissionStateChange}
            onResult={onResult}
            onClose={onClose}
          />
        </SliceJobTrackerProvider>
      </ColorCatalogProvider>
    </ThemeProvider>
  );
}

export function OrcaIntegrationPage() {
  const [searchParams] = useSearchParams();
  const mode = searchParams.get('mode');
  const protocolVersion = searchParams.get('protocol_version');
  const requestId = searchParams.get('request_id');

  if (
    (mode !== 'connect' && mode !== 'print')
    || protocolVersion !== '1'
    || !requestId
    || !requestId.trim()
    || requestId.length > 256
  ) {
    return <StatusMessage>Invalid Orca integration request. Reopen the Grove action from Orca.</StatusMessage>;
  }

  return mode === 'connect'
    ? <ConnectApplication requestId={requestId} />
    : <PrintMode requestId={requestId} />;
}
