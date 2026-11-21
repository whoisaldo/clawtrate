// The connection screens (visual-language.md, section 10, at phone size): the
// welcome screen with the mark and its one action (and, for a gateway an earlier
// install saved, the choice to reconnect to it), the gateway's address with the
// notice for an unencrypted one, the step list while it connects and loads, the
// pending approval with the scopes this device signed and its command to copy,
// and the notice for a gateway on another protocol. The row of characters stands
// at the foot. Every word comes from `@clawtrate/ui/connect-words`, as on the
// desktop, and nothing the gateway sent back shows a credential.

import type { ConnectionError, ConnectionState, DiscoveryState } from "@clawtrate/core";
import { ENSEMBLE, showEnsemble } from "../presentation/character.ts";
import {
  CLEARTEXT_WORDS,
  CONNECT_WORDS as W,
  countdownWords,
  failureTitle,
  footWords,
  isCleartext,
  pairingLede,
  pairingScopes,
  PRODUCT_NAME,
  protocolLede,
  scopesDifferWords,
  scopeWords,
  setupSteps,
  SLOGAN,
} from "../presentation/connect-words.ts";
import { gatewayLabel } from "../../../../packages/ui/src/format.ts";
import { addressWords } from "../presentation/gateway-state.ts";
import * as Clipboard from "expo-clipboard";
import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  Image,
  KeyboardAvoidingView,
  ScrollView,
  TextInput,
  useWindowDimensions,
  View,
} from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import MARK from "../../assets/logo-mark.png";
import { addressAttemptInProgress, addressSubmission } from "../address.ts";
import { Character } from "../components/Avatar.tsx";
import { EyeIcon } from "../components/icons.tsx";
import { Button, Dot, Txt } from "../components/ui.tsx";
import { APP_VERSION } from "../host/index.ts";
import { localNetworkHint } from "../local-network.ts";
import { useRuntime } from "../runtime.ts";
import { FONTS, S, TOUCH, useTheme } from "../theme/index.ts";

const HOST = `iPhone ${APP_VERSION}`;

function Column({ children, testID }: { children: ReactNode; testID: string }) {
  const { c } = useTheme();
  const { height } = useWindowDimensions();
  const ensemble = showEnsemble(height);
  const { bottom } = useSafeAreaInsets();
  return (
    <SafeAreaView edges={["top", "left", "right"]} style={{ flex: 1, backgroundColor: c.bg }}>
      <KeyboardAvoidingView behavior="padding" style={{ flex: 1 }}>
        <ScrollView
          testID={testID}
          keyboardShouldPersistTaps="handled"
          // The form is centred in the space above the characters, which stand on the bottom edge.
          contentContainerStyle={{ flexGrow: 1, paddingBottom: ensemble ? 0 : bottom }}
        >
          <View
            style={{
              flexGrow: 1,
              justifyContent: "center",
              paddingHorizontal: S["space-4"],
              paddingVertical: S["space-8"],
            }}
          >
            <View
              style={{
                width: "100%",
                maxWidth: TOUCH.column,
                alignSelf: "center",
                gap: S["space-4"],
              }}
            >
              {children}
            </View>
          </View>
          {ensemble && <Ensemble />}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

/**
 * The characters along the foot (section 10), scaled to 60% on the phone, on
 * the screen's bottom edge. Decoration only; below 640 points of height they
 * are not shown, so the form fits by itself.
 */
function Ensemble() {
  return (
    <View
      testID="ensemble"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      pointerEvents="none"
      style={{
        flexDirection: "row",
        justifyContent: "center",
        alignItems: "flex-end",
        overflow: "hidden",
        height: 90,
      }}
    >
      {ENSEMBLE.map(({ size, sink, lean, ...spec }, index) => {
        const side = Math.round(size * 0.6);
        return (
          <View
            key={index}
            style={{
              marginBottom: Math.round(side * sink),
              marginHorizontal: -6,
              transform: [{ rotate: `${lean}deg` }],
            }}
          >
            <Character spec={spec} size={side} />
          </View>
        );
      })}
    </View>
  );
}

/** The product's mark, at 56 points with a 16 point radius. Named when no name is beside it. */
function Mark({ named }: { named: boolean }) {
  return (
    <Image
      source={MARK}
      style={{ width: 56, height: 56, borderRadius: 16, alignSelf: "center" }}
      accessible={named}
      accessibilityRole={named ? "image" : "none"}
      accessibilityLabel={named ? PRODUCT_NAME : undefined}
      testID="mark"
    />
  );
}

function Brand() {
  return (
    <View style={{ alignItems: "center", gap: S["space-2"] }}>
      <Mark named={false} />
      <Txt
        size={S["text-title"]}
        weight="strong"
        accessibilityRole="header"
        style={{ letterSpacing: -0.28 }}
      >
        {PRODUCT_NAME}
      </Txt>
      <Txt size={S["text-base"]} color="text-muted">
        {SLOGAN}
      </Txt>
    </View>
  );
}

function Foot({ children }: { children: string }) {
  return (
    <Txt
      testID="connect-foot"
      size={S["text-xs"]}
      color="text-faint"
      style={{ textAlign: "center" }}
    >
      {children}
    </Txt>
  );
}

/** A failure: a medium-weight title and one sentence, on the danger fill, with Try again. */
function Failure({
  title,
  message,
  code,
  onTryAgain,
}: {
  title: string;
  message: string;
  code: string | null;
  onTryAgain: () => void;
}) {
  const { c } = useTheme();
  return (
    <View
      testID="connect-error"
      accessibilityRole="alert"
      style={{
        backgroundColor: c["danger-soft"],
        borderRadius: S["radius-md"],
        padding: S["space-4"],
        gap: S["space-2"],
      }}
    >
      <Txt testID="connect-error-title" weight="medium">
        {title}
      </Txt>
      <Txt testID="connect-error-message" size={S["text-md"]}>
        {message}
      </Txt>
      {code && (
        <Txt
          testID="connect-error-code"
          size={S["text-xs"]}
          color="text-faint"
          style={{ fontFamily: FONTS.mono }}
        >
          {code}
        </Txt>
      )}
      <Button label={W.tryAgain} onPress={onTryAgain} testID="try-again" />
    </View>
  );
}

/**
 * A connection error as the screen shows it: the gateway's words with any
 * credential this host holds scrubbed out, and, for a local gateway nobody
 * answered at, that iOS's Local Network permission may be the cause.
 */
function errorFor(error: ConnectionError, url: string | null, redact: (text: string) => string) {
  const local = localNetworkHint(error.code, url);
  return {
    title: failureTitle(error.code),
    message: redact([error.message, error.hint, local].filter(Boolean).join(" ")),
    code: redact(error.code),
  };
}

export function Welcome({
  onConnect,
  connection,
}: {
  onConnect: () => void;
  connection: ConnectionState;
}) {
  const { send, redact } = useRuntime();
  // A gateway kept from an earlier install, or after Disconnect, is a choice, never a default.
  const saved = connection.status === "disconnected" ? connection.gatewayUrl : null;
  return (
    <Column testID="welcome">
      <Brand />
      <Button
        label={W.connect}
        variant="primary"
        large
        onPress={onConnect}
        testID="connect-a-gateway"
      />
      {saved && (
        <Button
          label={redact(W.reconnectTo(gatewayLabel(saved)))}
          large
          onPress={() => void send({ type: "retry" })}
          testID="reconnect-saved"
        />
      )}
      <Txt size={S["text-sm"]} color="text-faint" style={{ textAlign: "center" }}>
        {W.hint}
      </Txt>
      <Foot>{footWords("connect", connection, HOST)}</Foot>
    </Column>
  );
}

function Field({
  value,
  onChange,
  placeholder,
  label,
  secret = false,
  testID,
  onSubmit,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  label: string;
  secret?: boolean;
  testID: string;
  onSubmit: () => void;
}) {
  const { c } = useTheme();
  return (
    <TextInput
      testID={testID}
      accessibilityLabel={label}
      value={value}
      onChangeText={onChange}
      placeholder={placeholder}
      placeholderTextColor={c["text-faint"]}
      secureTextEntry={secret}
      autoCapitalize="none"
      autoCorrect={false}
      spellCheck={false}
      keyboardType={secret ? "default" : "url"}
      // Neither is a password or a user name to save.
      textContentType="none"
      autoComplete="off"
      returnKeyType="go"
      onSubmitEditing={onSubmit}
      style={{
        minHeight: TOUCH.large,
        borderRadius: 999,
        paddingHorizontal: S["space-5"],
        backgroundColor: c["bg-inset"],
        color: c.text,
        fontFamily: FONTS.regular,
        fontSize: TOUCH.bodyText,
      }}
    />
  );
}

export function Address({
  connection,
  onBack,
}: {
  connection: ConnectionState;
  onBack: () => void;
}) {
  const { client, send, redact } = useRuntime();
  const [editedUrl, setEditedUrl] = useState<string | null>(null);
  const url = editedUrl ?? (connection.gatewayUrl ? addressWords(connection.gatewayUrl) : "");
  const [token, setToken] = useState("");
  const [submitError, setSubmitError] = useState<{ title: string; message: string } | null>(null);
  const submitting = useRef(false);
  const busy = addressAttemptInProgress(connection);
  const submit = async () => {
    if (submitting.current || addressAttemptInProgress(client.state.connection)) return;
    const command = addressSubmission(connection.gatewayUrl, url, token);
    if (!command) {
      setSubmitError(W.missingAddress);
      return;
    }
    submitting.current = true;
    setSubmitError(null);
    // The field is emptied before the screen changes: iOS offers to save what a
    // secure field holds when it goes, and this token is not one to keep there.
    setToken("");
    try {
      await send(command);
    } catch (error) {
      setSubmitError({
        title: failureTitle(null),
        message: redact(error instanceof Error ? error.message : String(error)),
      });
    } finally {
      submitting.current = false;
    }
  };
  const error = submitError
    ? { ...submitError, code: null }
    : connection.error
      ? errorFor(connection.error, connection.gatewayUrl, redact)
      : null;
  return (
    <Column testID="address">
      <Brand />
      <Txt accessibilityRole="header" weight="medium" style={{ textAlign: "center" }}>
        {W.connectTitle}
      </Txt>
      <Field
        testID="address-field"
        value={url}
        onChange={setEditedUrl}
        placeholder={W.address}
        label={W.address}
        onSubmit={submit}
      />
      {isCleartext(url) && <Cleartext />}
      <Field
        testID="token-field"
        value={token}
        onChange={setToken}
        placeholder={W.token}
        label={W.tokenLabel}
        secret
        onSubmit={submit}
      />
      {error && (
        <Failure
          title={error.title}
          message={error.message}
          code={error.code}
          onTryAgain={submit}
        />
      )}
      <Button
        label={busy ? W.connecting : W.connect}
        variant="primary"
        large
        disabled={busy}
        onPress={submit}
        testID="connect-button"
      />
      {!connection.gatewayUrl && (
        <Button label="Back" variant="quiet" large onPress={onBack} testID="address-back" />
      )}
      <Txt size={S["text-sm"]} color="text-faint" style={{ textAlign: "center" }}>
        {W.hint}
      </Txt>
    </Column>
  );
}

/** That a ws: address off this device is not encrypted: said before connecting, never refused. */
export function Cleartext() {
  const { c } = useTheme();
  return (
    <View
      testID="cleartext"
      accessible
      accessibilityLabel={`${CLEARTEXT_WORDS.title}. ${CLEARTEXT_WORDS.body}`}
      style={{
        backgroundColor: c["warn-soft"],
        borderRadius: S["radius-md"],
        padding: S["space-3"],
        gap: S["space-1"],
      }}
    >
      <Txt weight="medium" size={S["text-md"]}>
        {CLEARTEXT_WORDS.title}
      </Txt>
      <Txt size={S["text-sm"]}>{CLEARTEXT_WORDS.body}</Txt>
    </View>
  );
}

/** Ticks twice a second for a countdown. */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, []);
  return now;
}

function StepGlyph({ state }: { state: "done" | "current" | "pending" }) {
  const { c } = useTheme();
  return (
    <View
      style={{
        width: 12,
        height: 12,
        borderRadius: 6,
        borderWidth: state === "pending" ? 1.6 : 0,
        borderColor: c["text-faint"],
        backgroundColor:
          state === "done" ? c["accent-line"] : state === "current" ? c.warn : "transparent",
      }}
    />
  );
}

function Steps({
  connection,
  loadingBots,
  pairingText,
}: {
  connection: ConnectionState;
  loadingBots: boolean;
  pairingText?: string;
}) {
  const { redact } = useRuntime();
  return (
    <View accessibilityLabel={W.setupLabel} testID="setup-steps" style={{ gap: S["space-3"] }}>
      {setupSteps(connection, loadingBots).map((step, index) => (
        <View
          key={index}
          testID={`setup-step-${index}`}
          accessible
          accessibilityLabel={redact(step.label ?? pairingText ?? W.waitingStep)}
          accessibilityState={{ selected: step.state === "current" }}
          style={{ flexDirection: "row", alignItems: "center", gap: S["space-3"] }}
        >
          {step.waiting ? <Dot tone="connecting" size={10} /> : <StepGlyph state={step.state} />}
          <Txt size={S["text-md"]} color={step.state === "pending" ? "text-faint" : "text"}>
            {redact(step.label ?? pairingText ?? W.waitingStep)}
          </Txt>
        </View>
      ))}
    </View>
  );
}

export function Setup({
  connection,
  discovery,
  onAnother,
}: {
  connection: ConnectionState;
  discovery: DiscoveryState;
  onAnother: () => void;
}) {
  const { send, redact } = useRuntime();
  const loadingBots = connection.status === "connected" && discovery.status === "loading";
  const error = connection.error;
  return (
    <Column testID="setup">
      <Brand />
      <Steps connection={connection} loadingBots={loadingBots} />
      {error && !loadingBots && (
        <Failure
          {...errorFor(error, connection.gatewayUrl, redact)}
          onTryAgain={() => void send({ type: "retry" })}
        />
      )}
      <Button label={W.useAnother} variant="quiet" large onPress={onAnother} testID="use-another" />
      <Foot>{footWords("connect", connection, HOST)}</Foot>
    </Column>
  );
}

export function Pairing({
  connection,
  onAnother,
}: {
  connection: ConnectionState;
  onAnother: () => void;
}) {
  const { send, redact } = useRuntime();
  const { c } = useTheme();
  const pairing = connection.pairing!;
  // A command that carries a known token is neither shown nor offered to copy.
  const command =
    pairing.approveCommand && redact(pairing.approveCommand) === pairing.approveCommand
      ? pairing.approveCommand
      : null;
  const scopes = pairingScopes(connection);
  const now = useNow();
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);
  const copy = async (command: string) => {
    await Clipboard.setStringAsync(command);
    setCopied(true);
  };
  const [checking, setChecking] = useState(false);
  const [checked, setChecked] = useState(false);
  const check = async () => {
    if (checking) return;
    setChecking(true);
    try {
      await send({ type: "retry" });
    } finally {
      setChecking(false);
      setChecked(true);
    }
  };
  return (
    <Column testID="pairing">
      <Mark named />
      <Txt size={22} weight="strong" accessibilityRole="header" style={{ textAlign: "center" }}>
        {W.approveTitle}
      </Txt>
      <Txt size={S["text-base"]} color="text-muted" style={{ textAlign: "center" }}>
        {redact(pairingLede(connection.gatewayUrl))}
      </Txt>
      {pairing.approveNote && (
        <Txt size={S["text-sm"]} color="text-muted" testID="approve-note">
          {redact(pairing.approveNote)}
        </Txt>
      )}
      {command && (
        <View style={{ gap: S["space-2"] }}>
          <View
            style={{
              backgroundColor: c["bg-inset"],
              borderRadius: S["radius-sm"],
              padding: S["space-3"],
            }}
          >
            <Txt
              testID="approve-command"
              selectable
              size={S["text-sm"]}
              style={{ fontFamily: FONTS.mono }}
            >
              {command}
            </Txt>
          </View>
          <Button
            label={copied ? W.copied : W.copyApprove}
            onPress={() => void copy(command)}
            testID="copy-command"
          />
          <Txt
            testID="copy-status"
            accessibilityLiveRegion="polite"
            size={S["text-sm"]}
            color="text-muted"
          >
            {copied ? W.copied : ""}
          </Txt>
        </View>
      )}
      <Steps
        connection={connection}
        loadingBots={false}
        pairingText={`${checked ? W.notYet : W.waiting}${countdownWords(connection.retryAt, now)}`}
      />
      <View
        accessibilityLabel={W.scopesLabel}
        testID="scopes"
        style={{ flexDirection: "row", flexWrap: "wrap", gap: S["space-2"] }}
      >
        {scopes.asked.map((scope) => (
          <View
            key={scope}
            testID={`scope-${scope}`}
            accessible
            accessibilityLabel={scopeWords(scope)}
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: S["space-2"],
              backgroundColor: c["bg-bubble"],
              borderRadius: 999,
              paddingHorizontal: S["space-3"],
              paddingVertical: 6,
            }}
          >
            <EyeIcon color={c["text-muted"]} />
            <Txt size={S["text-md"]}>{scopeWords(scope)}</Txt>
          </View>
        ))}
      </View>
      {scopes.echoed && (
        <Txt testID="scopes-differ" size={S["text-sm"]} color="warn">
          {redact(scopesDifferWords(scopes.echoed))}
        </Txt>
      )}
      <Button
        label={checking ? W.checking : W.checkNow}
        large
        busy={checking}
        onPress={() => void check()}
        testID="check-now"
      />
      <Button label={W.useAnother} variant="quiet" large onPress={onAnother} testID="use-another" />
      <Foot>{redact(footWords("pairing", connection, HOST))}</Foot>
    </Column>
  );
}

export function Protocol({
  connection,
  error,
  onAnother,
}: {
  connection: ConnectionState;
  error: ConnectionError;
  onAnother: () => void;
}) {
  const { send, redact } = useRuntime();
  const retrying = connection.status === "connecting" || connection.status === "reconnecting";
  return (
    <Column testID="protocol-notice">
      <Mark named />
      <Txt size={22} weight="strong" accessibilityRole="header" style={{ textAlign: "center" }}>
        {W.protocolTitle}
      </Txt>
      <Txt
        testID="protocol-lede"
        size={S["text-base"]}
        color="text-muted"
        style={{ textAlign: "center" }}
      >
        {redact(protocolLede(connection.gatewayUrl, error.protocol))}
      </Txt>
      <Button
        label={retrying ? W.retrying : W.retry}
        large
        busy={retrying}
        onPress={() => {
          if (!retrying) void send({ type: "retry" });
        }}
        testID="protocol-retry"
      />
      <Button
        label={W.chooseAnother}
        variant="quiet"
        large
        onPress={onAnother}
        testID="choose-another"
      />
      <Foot>{redact(footWords("protocol", connection, HOST))}</Foot>
    </Column>
  );
}
