import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  InputAccessoryView,
  Keyboard,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type LayoutChangeEvent,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { useColors } from '@/hooks/useColors';
import { font, text } from '@/constants/type';
import { AgentTrace, TraceStep } from '@/components/AgentTrace';
import { PlacePicker } from '@/components/PlacePicker';
import { SendingIndicator } from '@/components/SendingIndicator';
import { QuestionRow } from '@/components/QuestionRow';
import {
  placeForQuestion,
  stateForArea,
  useApp,
  type CachedAnswer,
  type Place,
  type Visibility,
  isJobNearArea,
} from '@/contexts/AppContext';
import { useRefreshOnFocus } from '@/hooks/useRefreshOnFocus';
import { useDialog } from '@/contexts/DialogContext';
import {
  DEADLINE_PRESETS,
  DEFAULT_DEADLINE,
  MAX_DEADLINE,
  MIN_DEADLINE,
  formatDuration,
} from '@/constants/time';
import {
  BOUNTY_PRESETS,
  DEFAULT_BOUNTY,
  MAX_TIP,
  MIN_BOUNTY,
  MIN_TIP,
  NAIRA_PER_USD,
  VERIFIED_ONLY_ABOVE,
  TIP_PRESETS,
  formatNaira,
  pickupHint,
  toUsd,
  verifierCut,
} from '@/constants/money';
import { localityOf } from '@/utils/places';
import { tidyQuestion } from '@/utils/tidyQuestion';
import {
  tidyOnServer,
  checkIfKnown,
  knownHere,
  tipForAnswer,
  hasApi,
  type KnownAnswer,
  type KnownHere,
} from '@/utils/questionsApi';
import { KeyboardAwareScrollViewCompat } from '@/components/KeyboardAwareScrollViewCompat';
import { Wordmark } from '@/components/Wordmark';

type ScreenState = 'idle' | 'working' | 'found_answer' | 'needs_verification';


const INITIAL_STEPS: TraceStep[] = [
  { label: 'Reading your question', status: 'pending' },
  { label: 'Checking what is already online', status: 'pending' },
  { label: 'Looking for recent reports nearby', status: 'pending' },
  { label: 'Deciding if someone must go look', status: 'pending' },
];

/** How many feed rows to show before it stops being a glance. */
const FEED_LIMIT = 5;

function LiveDot({ color }: { color: string }) {
  const opacity = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    const anim = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, { toValue: 0.2, duration: 950, useNativeDriver: true }),
        Animated.timing(opacity, { toValue: 1, duration: 950, useNativeDriver: true }),
      ]),
    );
    anim.start();
    return () => anim.stop();
  }, [opacity]);
  return <Animated.View style={[styles.liveDot, { opacity, backgroundColor: color }]} />;
}

/**
 * Ties this screen's numeric fields to a Done bar.
 *
 * iOS gives a numeric keypad no return key, so once it is up there is nothing
 * on it that puts it away. Android is unaffected: its keypad carries its own
 * dismiss.
 */
const NUMERIC_ACCESSORY_ID = 'ask-numeric-accessory';

/**
 * Trims a place down to something that fits on one line.
 *
 * OSM hands back the full chain — "Agege Motor Road, Tinubu, Lagos" — which
 * wrapped the meta row onto a second line and pushed the next answer down. The
 * two ends are the parts that carry meaning: the street or landmark says which
 * place, the state says whether it is anywhere near you. The middle is
 * administrative filler.
 */
function shortPlace(area: string, max = 26): string {
  const full = area.trim();
  if (full.length <= max) return full;

  const parts = full.split(',').map((p) => p.trim()).filter(Boolean);

  if (parts.length > 2) {
    const ends = `${parts[0]}, ${parts[parts.length - 1]}`;
    if (ends.length <= max) return ends;
  }

  const first = parts[0] ?? full;
  // Cut on a word rather than mid-syllable; a bare slice reads as a typo.
  if (first.length <= max) return first;
  const cut = first.slice(0, max).replace(/\s+\S*$/, '');
  return `${cut || first.slice(0, max)}…`;
}

export default function AskScreen() {
  const colors = useColors();
  const { confirm, notify } = useDialog();
  /** True while the balance is being re-read, between the tap and the send. */
  const [checking, setChecking] = useState(false);
  /** True while the model is looking at the question. Drives the wand. */
  const [tidying, setTidying] = useState(false);
  const insets = useSafeAreaInsets();
  const {
    addQuery,
    dispatchQuery,
    tipVerifier,
    nearbyTasks,
    homeArea,
    locationFilter,
    questionsNearby,
    answeredNearby,
    activeQuestions,
    unreadCount,
    answersPublicByDefault,
    profile,
    refreshJobs,
    refreshMyQuestions,
    refreshNotifications,
    ngnPerUsd,
    usdcBalance,
    refreshBalance,
    recentQuestions,
  } = useApp();

  /**
   * Own questions, and the nearby counter above them.
   *
   * Both are other-side-of-the-world facts: a verifier taking your question
   * changes it, and questions appearing near you change the count. Neither
   * event reaches this device on its own.
   */
  useRefreshOnFocus(
    useCallback(
      // Notifications too: every row in that feed is somebody else acting on
      // your question, so the bell is stale for exactly as long as nothing
      // asks. "Somebody took your job" existed the moment they took it — it
      // just went unread until an unrelated refresh happened to collect it.
      () => Promise.all([refreshMyQuestions(), refreshJobs(), refreshNotifications()]),
      [refreshMyQuestions, refreshJobs, refreshNotifications],
    ),
  );

  // The live rate when we have one, the fallback constant only until then, so
  // this screen and the wallet never quote two different numbers.
  const rate = ngnPerUsd ?? NAIRA_PER_USD;

  /**
   * Both halves of this used to be invented: it always said "afternoon", and
   * it always said "Akin". The hour now comes from the clock and the name from
   * the signed-in profile — and with no username yet it greets without one
   * rather than guessing at who is holding the phone.
   */
  const greeting = useMemo(() => {
    const hour = new Date().getHours();
    const partOfDay = hour < 12 ? 'morning' : hour < 17 ? 'afternoon' : 'evening';
    return profile.username ? `Good ${partOfDay}, ${profile.username}` : `Good ${partOfDay}`;
  }, [profile.username]);

  /** Fresh reads green, half a day old reads red. */
  const ageTone = (hours: number) =>
    hours <= 2 ? colors.primary : hours <= 8 ? colors.pending : colors.danger;
  const topPad = Platform.OS === 'web' ? 22 : insets.top + 6;

  const [question, setQuestion] = useState('');
  const [state, setState] = useState<ScreenState>('idle');
  const [steps, setSteps] = useState<TraceStep[]>(INITIAL_STEPS);
  const [queryId, setQueryId] = useState('');
  const [place, setPlace] = useState<Place | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  /**
   * What the network already holds for the chosen place.
   *
   * Fetched as soon as a place is picked, so coverage is visible before the
   * decision rather than after it. Nothing is charged and nothing is asked —
   * this only reports what exists.
   */
  const [here, setHere] = useState<KnownHere[]>([]);
  const [hereOpen, setHereOpen] = useState(false);
  const [composing, setComposing] = useState(false);
  const [bounty, setBounty] = useState(String(DEFAULT_BOUNTY));
  const [deadline, setDeadline] = useState(String(DEFAULT_DEADLINE));
  const [visibility, setVisibility] = useState<Visibility>(
    answersPublicByDefault ? 'public' : 'private',
  );
  const [verifiedOnly, setVerifiedOnly] = useState(false);
  const [cached, setCached] = useState<CachedAnswer | null>(null);
  /** What the server judgment found, read by the trace timer when it fires. */
  const found = useRef<KnownAnswer | null>(null);
  /**
   * Why the agent decided what it did, in its own words.
   *
   * Worth showing rather than summarising. "The last check here was 2018
   * minutes ago, which is too old to stand in" tells somebody about to spend
   * ₦500 exactly what they are paying for, and it is obviously not a canned
   * line — which is most of why it is convincing.
   */
  const reasonRef = useRef<string | null>(null);
  const [reason, setReason] = useState<string | null>(null);
  const [tipped, setTipped] = useState(0);
  /** Blocks a second tap while the first is still with the server. */
  const [tipping, setTipping] = useState(false);
  const [tipCustom, setTipCustom] = useState(false);
  const [tipDraft, setTipDraft] = useState('');
  const [confirmOpen, setConfirmOpen] = useState(false);
  /**
   * From the confirm tap until the bounty is locked or the attempt fails.
   *
   * Covers two wallet dialogs and a relayed transaction, which is long enough
   * that a screen showing nothing reads as a dropped tap and gets tapped
   * again.
   */
  const [sending, setSending] = useState(false);

  // Captured at press time: once a fix is applied the input matches the
  // tidied text, so `canTidy` is already false and cannot report what just
  // happened.
  const [checkResult, setCheckResult] = useState<'fixed' | 'clean' | 'limited' | null>(null);

  const inputRef = useRef<TextInput>(null);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const checkTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const bountyRef = useRef<TextInput>(null);
  const deadlineRef = useRef<TextInput>(null);
  const tipRef = useRef<TextInput>(null);
  const scrollRef = useRef<ScrollView>(null);

  // Set the moment a result is about to appear, then consumed by that card's
  // own onLayout. Waiting for layout is the point: the card's position is not
  // known at the time the state changes, so scrolling then would guess.
  const pendingScroll = useRef(false);

  function revealResult(event: LayoutChangeEvent) {
    if (!pendingScroll.current) return;
    pendingScroll.current = false;

    const { y } = event.nativeEvent.layout;
    requestAnimationFrame(() => {
      scrollRef.current?.scrollTo({ y: Math.max(y - 24, 0), animated: true });
    });
  }
  /**
   * The same jobs the Near me tab lists, counted the same way.
   *
   * This counted every open job anywhere, so it read 2 while the tab it sends
   * you to showed none of them — the tile described a different board than the
   * one behind it. Both sides now run isJobNearArea.
   */
  const nearLabel = locationFilter?.label ?? homeArea?.label ?? '';
  const openLive = nearbyTasks.filter(
    (t) => t.status === 'available' && isJobNearArea(t, nearLabel),
  ).length;

  useEffect(
    () => () => {
      timers.current.forEach(clearTimeout);
      if (checkTimer.current) clearTimeout(checkTimer.current);
    },
    [],
  );

  function advance(index: number, next?: ScreenState) {
    setSteps((prev) =>
      prev.map((s, i) =>
        i < index
          ? { ...s, status: 'complete' }
          : i === index
            ? { ...s, status: 'active' }
            : s,
      ),
    );
    if (next) {
      timers.current.push(
        setTimeout(() => {
          setSteps((prev) => prev.map((s) => ({ ...s, status: 'complete' })));
          pendingScroll.current = true;
          setState(next);
        }, 1700),
      );
    }
  }

  // A verifier has to be told where to walk to, so a question without a place
  // is not answerable. Asking is held until both are in rather than guessing
  // the place from the wording, which only ever worked for phrasings we had
  // hard-coded.
  const bountyValue = Number.parseInt(bounty, 10) || 0;
  const bountyValid = bountyValue >= MIN_BOUNTY;
  const isCustom = bounty !== '' && !BOUNTY_PRESETS.includes(bountyValue);

  const deadlineValue = Number.parseInt(deadline, 10) || 0;
  const deadlineValid = deadlineValue >= MIN_DEADLINE && deadlineValue <= MAX_DEADLINE;
  const isCustomDeadline = deadline === '' || !DEADLINE_PRESETS.includes(deadlineValue);

  // Big errands are restricted regardless, so the switch shows it as on and
  // stops being a choice rather than silently overriding the user later.
  const verifiedForced = bountyValue >= VERIFIED_ONLY_ABOVE;
  const verifiedOn = verifiedOnly || verifiedForced;

  // Asking costs nothing, so the only gate is a question and a place.
  const canAsk = question.trim().length > 0 && place !== null;
  const placeLocality = place ? localityOf(place) : null;

  // Saved places carry a bare area like "Ikeja", so the state is looked up and
  // appended. A searched result already ends in its state, so it is left be.
  const areaState = place ? stateForArea(place.area) : null;
  const areaLine = place ? (areaState ? `${place.area}, ${areaState}` : place.area) : '—';

  useEffect(() => {
    setHere([]);
    setHereOpen(false);
    if (!place || !hasApi) return;

    let stopped = false;
    void (async () => {
      const result = await knownHere(place.name, place.coords ?? null);
      // Silent on failure: this is a convenience, and somebody asking a
      // question must never be held up by one.
      if (!stopped && result.ok) setHere(result.data.answers);
    })();
    return () => {
      stopped = true;
    };
  }, [place]);

  const tipDraftValue = Number.parseInt(tipDraft, 10) || 0;
  const tipDraftValid = tipDraftValue >= MIN_TIP && tipDraftValue <= MAX_TIP;

  /**
   * Confirms, then actually pays.
   *
   * Both halves were missing. It went straight through on one tap — real money
   * with no chance to say no, on a screen where the amounts sit next to each
   * other and a thumb can find the wrong one — and what it did was append a
   * row to local wallet history, so the verifier was never paid and the entry
   * vanished on reload.
   */
  async function sendTip(amount: number, verifierName: string) {
    if (amount <= 0 || tipping) return;

    const go = await confirm({
      title: `Tip ${verifierName} ₦${formatNaira(amount)}?`,
      message:
        'They already went and checked this, and you are getting the answer without sending anybody. This comes out of your balance now.',
      confirmLabel: `Send ₦${formatNaira(amount)}`,
      cancelLabel: 'Not now',
    });
    if (!go) return;

    if (Platform.OS !== 'web') Haptics.selectionAsync();
    setTipping(true);

    /**
     * Only shown as sent once the server says so.
     *
     * Showing it immediately and correcting later would tell somebody their
     * money moved when it may not have, on the one screen where the whole
     * point is that a payment is real.
     */
    const result = cached ? await tipForAnswer(cached.id, amount) : { ok: false as const, detail: 'Nothing to tip.' };
    setTipping(false);

    if (!result.ok) {
      await notify({
        title: 'That tip did not go through',
        message: 'detail' in result && result.detail ? result.detail : 'Nothing was taken from your balance.',
      });
      return;
    }

    tipVerifier(amount, verifierName);
    setTipped(amount);
    setTipCustom(false);
    setTipDraft('');
  }

  /**
   * What this bounty costs in USDC, and whether the wallet holds it.
   *
   * The chain is what decides: funding pulls USDC out of the asker's wallet,
   * so a naira figure we like the look of is beside the point. Unknown balance
   * blocks the send rather than allowing it — failing closed is the only safe
   * direction when the amount available has not been read.
   */
  const bountyUsdc = ngnPerUsd ? bountyValue / ngnPerUsd : null;
  const canAfford =
    bountyUsdc === null || usdcBalance === null ? false : usdcBalance >= bountyUsdc;

  const shortfallNaira =
    bountyUsdc !== null && usdcBalance !== null && ngnPerUsd && usdcBalance < bountyUsdc
      ? Math.ceil((bountyUsdc - usdcBalance) * ngnPerUsd)
      : 0;

  const readyToSend = bountyValid && deadlineValid && canAfford;

  /**
   * Asks before taking the money.
   *
   * Sending a question moves real USDC into escrow and asks somebody to walk
   * somewhere. That deserves a deliberate second tap and a plain account of
   * what happens to the money — including the part people most want to know,
   * which is what happens if nobody turns up.
   */
  function handleDispatch() {
    if (!readyToSend) return;
    setConfirmOpen(true);
  }

  /**
   * Checks the money again before spending it.
   *
   * `canAfford` gates the Send button, but it reads a balance that was fetched
   * at some earlier point — so a stale figure let the question through, and
   * the refusal arrived on the tracking screen after the question had been
   * created and navigated to. Being told "you have $0.01" two screens after
   * committing is the wrong place to learn it.
   *
   * The read is cheap and this is the one moment it has to be right.
   */
  async function confirmDispatch() {
    // Guards a double tap: the sheet stays open while the balance is read, so
    // the button is still there to be pressed again.
    if (checking) return;
    setChecking(true);

    const fresh = await refreshBalance();
    const needed = ngnPerUsd ? bountyValue / ngnPerUsd : null;
    setChecking(false);

    if (needed !== null && fresh !== null && fresh < needed) {
      const short = Math.ceil((needed - fresh) * (ngnPerUsd ?? 0));
      /**
       * The sheet stays open behind this.
       *
       * Closing it would drop them back to the form with the amount they had
       * just agreed to, and nothing to act on — leaving it up means Not yet is
       * still there, and so is the figure being questioned.
       */
      await notify({
        title: 'Not enough to send this',
        message: `This costs about $${needed.toFixed(2)} and you have $${fresh.toFixed(2)}. Top up around ₦${formatNaira(short)} and try again.`,
      });
      return;
    }

    setConfirmOpen(false);

    if (Platform.OS !== 'web') Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);

    /**
     * Wait for the money before showing the screen about the job.
     *
     * This used to navigate immediately, which on a phone was near enough to
     * true: the embedded wallet signs without a prompt and the relay follows
     * in a second. In a wallet host it is two dialogs and a transaction, so
     * "waiting for somebody" appeared while nobody had agreed to pay yet, and
     * stayed there through a signature and a relay that might both fail.
     *
     * Now the tracker is only reached when there is genuinely something to
     * track. A failure leaves you on this screen, with the question still
     * filled in and the reason shown.
     */
    setSending(true);
    const funded = await dispatchQuery(
      queryId,
      bountyValue,
      visibility,
      deadlineValue,
      verifiedOnly,
    );
    setSending(false);

    if (funded) router.push(`/tracking/${queryId}`);
  }

  // Shown from the moment the box is tapped, narrowing as you type. Not tied
  // to blur: on web the input blurs on mouse-down, so hiding there would pull
  // the row out from under the click that was selecting it.
  const typed = question.trim().toLowerCase();

  /**
   * Your own questions first, other people's behind them.
   *
   * Somebody checking the same filling station every morning should find it
   * at the top rather than retyping it. A new account has none, so the
   * nearby list is all it sees — which is also the only honest thing to show
   * when there is no history to draw on.
   */
  const mineMatching = composing
    ? recentQuestions
        .filter((q) => !typed || q.toLowerCase().includes(typed))
        .map((q, i) => ({ id: `mine-${i}`, text: q, mine: true as const, place: null }))
    : [];

  const nearbyMatching = composing
    ? questionsNearby
        .filter((q) => !typed || q.text.toLowerCase().includes(typed))
        // Never twice: a question of theirs that is also on the board belongs
        // in the first group, not both.
        .filter((q) => !recentQuestions.some((r) => r.toLowerCase() === q.text.toLowerCase()))
        .map((q) => ({ id: q.id, text: q.text, mine: false as const, place: q }))
    : [];

  /**
   * Examples, shown only when there is nothing real to offer.
   *
   * Clearly labelled as examples and carrying no place, because they are not
   * questions anybody asked — they exist to show what a good one looks like.
   * The first thing a new account sees should teach the shape of the thing,
   * not an empty box.
   *
   * Anything real outranks them: your own history first, other people's open
   * questions next, and these only when both are empty.
   */
  const examples = [
    'Is there fuel at this station right now?',
    'How long is the queue?',
    'Is this shop open today?',
    'Is the road flooded?',
    'What are they charging per litre?',
  ];

  const exampleMatching =
    composing && mineMatching.length === 0 && nearbyMatching.length === 0
      ? examples
          .filter((q) => !typed || q.toLowerCase().includes(typed))
          .map((q, i) => ({ id: `eg-${i}`, text: q, mine: false as const, place: null }))
      : [];

  const suggestions = [...mineMatching, ...nearbyMatching, ...exampleMatching].slice(
    0,
    FEED_LIMIT,
  );

  const showingExamples = exampleMatching.length > 0;

  function handleAsk() {
    const q = question.trim();
    if (!q || !place) return;

    Keyboard.dismiss();
    if (Platform.OS !== 'web') Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);

    setComposing(false);
    setTipped(0);
    setVisibility(answersPublicByDefault ? 'public' : 'private');

    setCached(null);

    const id = addQuery(q, place);
    setQueryId(id);
    setSteps(INITIAL_STEPS.map((s) => ({ ...s, status: 'pending' })));
    setState('working');

    /**
     * Asked while the trace runs, not before it.
     *
     * The steps take about five seconds either way, and the judgment takes
     * about two, so it finishes inside a wait that already existed. Doing it
     * first would put a spinner in front of somebody who has just pressed the
     * button, to tell them something they may not even need.
     *
     * `found` is a ref rather than state because the timer below reads it at
     * the moment it fires, and a state write from an await would not have
     * reached that closure.
     */
    found.current = null;
    reasonRef.current = null;
    setReason(null);
    void (async () => {
      if (!hasApi) return;
      const result = await checkIfKnown(q, place.name, place.coords ?? null);
      if (!result.ok) return;
      reasonRef.current = result.data.because ?? null;
      if (result.data.known && result.data.answer) {
        found.current = result.data.answer;
      }
    })();

    timers.current = [
      setTimeout(() => advance(0), 200),
      setTimeout(() => advance(1), 1700),
      setTimeout(() => advance(2), 3200),
      setTimeout(() => {
        /**
         * Whatever the check found by now, which may be nothing.
         *
         * Not awaited: a slow judgment must not hold the trace open past the
         * point it has run out of things to say. Missing it costs one
         * unnecessary dispatch, which is exactly what happened before any of
         * this existed.
         */
        const known = found.current;
        setReason(reasonRef.current);
        setCached(
          known
            ? {
                id: known.id,
                placeName: known.placeName,
                area: known.area,
                answer: known.answer,
                detail: known.detail,
                proof: known.proof,
                confirmed: known.confirmed,
                ageHours: known.ageHours,
                ageLabel: known.ageLabel,
                verifierName: known.verifierName,
                verifierInitials: known.verifierInitials,
                visibility: 'public',
              }
            : null,
        );
        advance(3, known ? 'found_answer' : 'needs_verification');
      }, 4700),
    ];
  }

  const tidied = tidyQuestion(question);
  /** Mirrors `question` for the async tidy, which cannot read stale state. */
  const questionRef = useRef(question);
  questionRef.current = question;
  const canTidy = tidied !== '' && tidied !== question;

  // The button always answers when there is text to check. Silently doing
  // nothing on already-clean input is indistinguishable from being broken,
  // so a clean pass confirms itself instead.
  /**
   * The local pass first, then the model.
   *
   * tidyQuestion corrects by edit distance against a word list, which is
   * instant and free and cannot help with "flaad" — nothing in a fixed list
   * is close enough to "flood", and no list will ever hold every place name a
   * question might mention. So the local result is applied immediately, and
   * the model is asked to improve on it in the background.
   *
   * Applying the local fix up front is what keeps the button honest when the
   * network is slow or absent: something happens on every tap, and the model
   * only ever adds to it.
   */
  async function handleTidy() {
    const original = question.trim();
    if (!original) return;
    if (Platform.OS !== 'web') Haptics.selectionAsync();

    const local = canTidy ? tidied : original;
    if (canTidy) setQuestion(local);

    setTidying(true);
    const better = await tidyOnServer(local);
    setTidying(false);

    /**
     * Only overwrite if they have not carried on typing.
     *
     * The request takes a second or two, and pulling the field out from under
     * somebody mid-sentence to replace it with a correction of what they used
     * to have written is worse than leaving the typo alone.
     */
    const stillTheirs = questionRef.current.trim() === local;
    const fixed = better.ok && better.data.changed && stillTheirs;
    if (fixed) setQuestion(better.data.text);

    /**
     * Says when the day's checks are used up.
     *
     * The local pass has already run, so the button did something either way —
     * but a person who taps twice more and sees nothing change would fairly
     * conclude it was broken. Two a day is a small enough allowance that it
     * has to announce itself.
     */
    const outOfChecks = better.ok && better.data.limited === true;

    setCheckResult(outOfChecks ? 'limited' : fixed || canTidy ? 'fixed' : 'clean');
    if (checkTimer.current) clearTimeout(checkTimer.current);
    checkTimer.current = setTimeout(() => setCheckResult(null), outOfChecks ? 3200 : 1500);
  }

  function reset() {
    timers.current.forEach(clearTimeout);
    setState('idle');
    setQuestion('');
    setSteps(INITIAL_STEPS);
    setCached(null);
    setTipped(0);
    setTipCustom(false);
    setTipDraft('');
  }

  return (
    <View style={[styles.screen, { backgroundColor: colors.background }]}>
      <KeyboardAwareScrollViewCompat
        ref={scrollRef}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={[styles.scroll, { paddingTop: topPad }]}
      >
        {/* ── Masthead ─────────────────────────────────────────────── */}
        <View style={styles.masthead}>
          {/* The shared mark, not a fourth copy of it. Every screen drawing
              its own is exactly why renaming the app reached none of them. */}
          <Wordmark size={19} />
          <View style={styles.mastheadRight}>
            {state !== 'idle' ? (
              <Pressable
                onPress={reset}
                hitSlop={10}
                style={[styles.ghostBtn, { borderColor: colors.border }]}
              >
                <Ionicons name="close" size={17} color={colors.mutedForeground} />
              </Pressable>
            ) : (
              <Pressable
                onPress={() => router.push('/notifications')}
                hitSlop={10}
                accessibilityRole="button"
                accessibilityLabel={
                  unreadCount > 0 ? `Alerts, ${unreadCount} unread` : 'Alerts'
                }
                style={[styles.ghostBtn, { borderColor: colors.border }]}
              >
                <Ionicons name="notifications-outline" size={17} color={colors.mutedForeground} />
                {/* A lit corner, not a count — the number belongs on the
                    screen itself where there is room to read it. */}
                {unreadCount > 0 && (
                  <View
                    style={[
                      styles.bellDot,
                      { backgroundColor: colors.accent, borderColor: colors.background },
                    ]}
                  />
                )}
              </Pressable>
            )}
          </View>
        </View>

        {/* ── Status panel ─────────────────────────────────────────── */}
        <View style={[styles.board, { borderColor: colors.border }]}>
          {/* Was a hardcoded "23 verifiers online". We have no presence
              tracking, so that number was not merely wrong — it was
              unknowable. This counts answers that actually came back. */}
          <View style={styles.boardCell}>
            <LiveDot color={colors.primary} />
            <Text style={[styles.reading, { color: colors.foreground }]}>
              {answeredNearby.length}
            </Text>
            <Text style={[styles.cellLabel, { color: colors.faintForeground }]}>
              Answered{'\n'}nearby
            </Text>
          </View>

          <View style={[styles.boardDivider, { backgroundColor: colors.border }]} />

          {/* A count of things somebody could go and do is a way in, not a
              readout. Lands on Earn with the Near me filter already applied,
              so the list matches the number that was tapped. */}
          <Pressable
            onPress={() => router.push('/(tabs)/earn?filter=near')}
            accessibilityRole="button"
            accessibilityLabel={`${openLive} jobs around you. Opens the jobs near you.`}
            style={({ pressed }) => [styles.boardCell, { opacity: pressed ? 0.6 : 1 }]}
          >
            <Text style={[styles.reading, { color: colors.accent }]}>{openLive}</Text>
            <Text style={[styles.cellLabel, { color: colors.faintForeground, flex: 1 }]}>
              Jobs{'\n'}around you
            </Text>
            {/* This cell goes somewhere and the one beside it does not, and
                nothing said so — two identical-looking readouts, one of them
                secretly a link. */}
            <Ionicons name="chevron-forward" size={14} color={colors.accent} />
          </Pressable>
        </View>

        {state === 'idle' && (
          <>
            {/* ── Headline ─────────────────────────────────────────── */}
            <Text style={[text.bodySmall, styles.greeting, { color: colors.mutedForeground }]}>
              {greeting}
            </Text>
            <Text style={[text.display, styles.headline, { color: colors.foreground }]}>
              What do you need{'\n'}
              <Text style={{ color: colors.accent }}>checked</Text> right now?
            </Text>

            {/* ── The ask ──────────────────────────────────────────── */}
            <View
              style={[
                styles.composer,
                { backgroundColor: colors.surface, borderColor: colors.borderStrong },
              ]}
            >
              <View>
                <TextInput
                  ref={inputRef}
                  style={[text.body, styles.composerInput, { color: colors.foreground }]}
                  placeholder="Ask about any place, right now…"
                  placeholderTextColor={colors.faintForeground}
                  value={question}
                  onChangeText={setQuestion}
                  onFocus={() => setComposing(true)}
                  multiline
                  returnKeyType="send"
                  onSubmitEditing={() => handleAsk()}
                />

                {/* Sits over the field, appearing only once there is text to
                    act on, so an empty composer stays uncluttered. */}
                {question.trim().length > 0 && (
                  <Pressable
                    onPress={() => void handleTidy()}
                    disabled={tidying}
                    hitSlop={10}
                    accessibilityRole="button"
                    accessibilityLabel="Fix typos in your question"
                    style={({ pressed }) => [styles.wandBtn, { opacity: pressed ? 0.5 : 1 }]}
                  >
                    {/* The check now goes to a model and takes a moment, so
                        the button says so rather than looking unresponsive. */}
                    {tidying ? (
                      <ActivityIndicator size="small" color={colors.mutedForeground} />
                    ) : (
                      <Ionicons
                        name={
                          checkResult === 'limited'
                            ? 'time-outline'
                            : checkResult
                              ? 'checkmark'
                              : 'color-wand-outline'
                        }
                        size={18}
                        color={
                          checkResult === 'limited'
                            ? colors.pending
                            : checkResult
                              ? colors.primary
                              : colors.mutedForeground
                        }
                      />
                    )}
                  </Pressable>
                )}
              </View>

              <View style={[styles.composerFoot, { borderTopColor: colors.border }]}>
                <Pressable
                  onPress={() => setPickerOpen(true)}
                  accessibilityRole="button"
                  accessibilityLabel="Choose the place to check"
                  style={({ pressed }) => [
                    styles.placeChip,
                    {
                      borderColor: place ? colors.primary : colors.border,
                      opacity: pressed ? 0.6 : 1,
                    },
                  ]}
                >
                  <Ionicons
                    name={place ? 'location' : 'location-outline'}
                    size={13}
                    color={place ? colors.primary : colors.faintForeground}
                  />
                  <Text
                    style={[
                      text.data,
                      { color: place ? colors.foreground : colors.faintForeground, flexShrink: 1 },
                    ]}
                    numberOfLines={1}
                  >
                    {place ? place.name : 'Add a place'}
                    {/* Which Chicken Republic? The branch name alone is not
                        enough to send somebody to. */}
                    {placeLocality && (
                      <Text style={{ color: colors.mutedForeground }}> · {placeLocality}</Text>
                    )}
                  </Text>
                </Pressable>

                <Pressable
                  onPress={() => handleAsk()}
                  disabled={!canAsk}
                  style={({ pressed }) => [
                    styles.sendBtn,
                    {
                      backgroundColor: canAsk ? colors.accent : colors.sunken,
                      opacity: pressed ? 0.85 : 1,
                    },
                  ]}
                >
                  <Text
                    style={[
                      text.action,
                      { color: canAsk ? colors.accentForeground : colors.faintForeground },
                    ]}
                  >
                    Ask
                  </Text>
                  <Ionicons
                    name="arrow-forward"
                    size={15}
                    color={canAsk ? colors.accentForeground : colors.faintForeground}
                  />
                </Pressable>
              </View>
            </View>

            {/*
              * What is already known about this place.
              *
              * Sits under the composer because it is context for a decision
              * not yet made, not a result. Coverage used to be invisible until
              * after you had asked, so every question was partly a guess about
              * whether anybody had ever been there.
              */}
            {state === 'idle' && here.length > 0 && (
              <View style={[styles.hereCard, { borderColor: colors.border }]}>
                <Pressable
                  onPress={() => setHereOpen((v) => !v)}
                  style={styles.hereHead}
                  accessibilityRole="button"
                  accessibilityLabel="See what is already known about this place"
                >
                  <Ionicons name="checkmark-circle" size={14} color={colors.primary} />
                  <Text style={[text.bodySmall, { color: colors.foreground, flex: 1 }]}>
                    {here.length === 1
                      ? `Somebody checked here ${here[0]!.ageLabel}`
                      : `${here.length} checks here · last ${here[0]!.ageLabel}`}
                  </Text>
                  <Ionicons
                    name={hereOpen ? 'chevron-up' : 'chevron-down'}
                    size={14}
                    color={colors.faintForeground}
                  />
                </Pressable>

                {hereOpen &&
                  here.map((a) => (
                    <View key={a.id} style={[styles.hereRow, { borderTopColor: colors.border }]}>
                      <Text style={[text.data, { color: colors.faintForeground }]}>
                        {a.ageLabel}
                        {a.verifier ? ` · ${a.verifier}` : ''}
                        {a.confirmed ? ' · confirmed' : ''}
                      </Text>
                      <Text style={[text.bodySmall, { color: colors.mutedForeground, marginTop: 2 }]}>
                        {a.question}
                      </Text>
                      <Text style={[text.body, { color: colors.foreground, marginTop: 2 }]}>
                        {a.answer}
                      </Text>
                    </View>
                  ))}
              </View>
            )}

            {/* Never leave Ask greyed out without saying what is missing. */}
            {question.trim().length > 0 && !place && (
              <Pressable onPress={() => setPickerOpen(true)} style={styles.askHint}>
                <Ionicons name="arrow-up" size={13} color={colors.accent} />
                <Text style={[text.bodySmall, { color: colors.accent, flex: 1 }]}>
                  Pick the place you want checked, then you can ask.
                </Text>
              </Pressable>
            )}

            {/* ── Quick-pick, only while the composer is in use ────────
                Each row carries its own place, so one tap fills the question
                and the location together and Ask goes live immediately. */}
            {suggestions.length > 0 && (
              <View style={styles.suggestBox}>
                <View style={styles.suggestHead}>
                  <Text style={[text.label, { color: colors.faintForeground }]}>
                    {showingExamples
                      ? 'For example'
                      : mineMatching.length > 0
                        ? 'You asked before'
                        : question.trim()
                          ? 'Matching nearby'
                          : 'Asked nearby'}
                  </Text>
                  <Pressable onPress={() => setComposing(false)} hitSlop={10}>
                    <Ionicons name="close" size={15} color={colors.faintForeground} />
                  </Pressable>
                </View>

                {suggestions.map((q) => (
                  <Pressable
                    key={q.id}
                    onPress={() => {
                      setQuestion(q.text);
                      // Their own past questions carry no place: the same
                      // question next week is usually about the same spot,
                      // but assuming that would pick a place they did not.
                      if (q.place) setPlace(placeForQuestion(q.place));
                      setComposing(false);
                    }}
                    style={({ pressed }) => [
                      styles.prompt,
                      {
                        borderColor: colors.border,
                        backgroundColor: pressed ? colors.sunken : 'transparent',
                      },
                    ]}
                  >
                    <View style={{ flex: 1, gap: 3 }}>
                      <Text style={[text.body, { color: colors.foreground }]}>{q.text}</Text>
                      {/* Only rows that carry a place have one to name. Their
                          own past questions do not — the place is chosen
                          fresh each time rather than assumed. */}
                      {q.place && (
                        <Text style={[text.data, { color: colors.faintForeground }]}>
                          {q.place.placeName}
                          {q.place.area !== homeArea?.label ? ` · ${q.place.area}` : ''}
                        </Text>
                      )}
                    </View>
                    <Ionicons name="return-down-forward" size={14} color={colors.faintForeground} />
                  </Pressable>
                ))}
              </View>
            )}

            {/* ── Questions you are waiting on ─────────────────────── */}
            {activeQuestions.length > 0 && (
              <>
                <View style={styles.feedHead}>
                  <Text style={[text.label, { color: colors.faintForeground }]}>
                    Your questions
                  </Text>
                  <Text style={[text.data, { color: colors.faintForeground }]}>
                    {activeQuestions.length}
                  </Text>
                </View>

                {/* A preview, not the list — the two most recent, then out. */}
                {activeQuestions.slice(0, 2).map((q) => (
                  <QuestionRow
                    key={q.id}
                    question={q}
                    onPress={() => router.push(`/tracking/${q.id}`)}
                  />
                ))}

                <Pressable
                  onPress={() => router.push('/my-questions')}
                  style={({ pressed }) => [
                    styles.viewAll,
                    { borderColor: colors.border, opacity: pressed ? 0.6 : 1 },
                  ]}
                >
                  <Text style={[text.action, { color: colors.foreground }]}>
                    View all {activeQuestions.length}
                  </Text>
                  <Ionicons name="arrow-forward" size={14} color={colors.foreground} />
                </Pressable>
              </>
            )}

            {/* ── Answered nearby ──────────────────────────────────── */}
            <View style={styles.feedHead}>
              <Text style={[text.label, { color: colors.faintForeground }]}>Answered nearby</Text>
              <Text style={[text.data, { color: colors.faintForeground }]}>
                {/* Says "Anywhere" rather than a town nobody chose. The feed
                    behind it is genuinely unfiltered in that state. */}
                {homeArea?.label ?? 'Anywhere'}
              </Text>
            </View>

            <View style={styles.recentList}>
              {answeredNearby.slice(0, FEED_LIMIT).map((item) => (
                <View
                  key={item.id}
                  style={[styles.recentRow, { borderBottomColor: colors.border }]}
                >
                  <View style={{ flex: 1, gap: 7 }}>
                    <Text style={[text.subheading, { color: colors.foreground }]} numberOfLines={2}>
                      {item.text}
                    </Text>
                    {/* Facts, not a score: what proof exists, whether the
                        asker accepted it, and how stale it is. */}
                    <View style={styles.recentMeta}>
                      <Ionicons
                        name={item.confirmed ? 'checkmark-circle' : 'ellipse-outline'}
                        size={12}
                        color={item.confirmed ? colors.primary : colors.pending}
                      />
                      <Text
                        style={[
                          text.data,
                          { color: item.confirmed ? colors.primary : colors.pending },
                        ]}
                      >
                        {item.confirmed ? 'Confirmed' : 'Unconfirmed'}
                      </Text>
                      <Text style={[text.data, { color: colors.faintForeground }]}>
                        {/* The proof kind is not the reader's business here:
                            confirmed is confirmed, and whether it came as a
                            photo or a clip changes nothing about the answer. */}
                        · {item.ago}
                        {/*
                          * The place, at its most specific.
                          *
                          * This showed `area`, which for anything asked through
                          * an agent is the town it inherited — so five different
                          * streets all read "Benin City, Edo" and the one field
                          * that said which street was ignored.
                          */}
                        {(() => {
                          const where = item.placeName || item.area;
                          return where && where !== homeArea?.label
                            ? ` · ${shortPlace(where)}`
                            : '';
                        })()}
                      </Text>
                    </View>
                  </View>
                </View>
              ))}
            </View>
          </>
        )}

        {/* ── Working / dispatch states ────────────────────────────── */}
        {state !== 'idle' && (
          <>
            <Text style={[text.label, styles.sectionLabel, { color: colors.faintForeground }]}>
              You asked
            </Text>
            <Text style={[text.title, styles.askedBack, { color: colors.foreground }]}>
              {question}
            </Text>

            <View
              style={[
                styles.tracePanel,
                { backgroundColor: colors.surface, borderColor: colors.border },
              ]}
            >
              <AgentTrace steps={steps} />
            </View>
          </>
        )}

        {/* ── An answer someone already paid for ───────────────────── */}
        {state === 'found_answer' && cached && (
          <View onLayout={revealResult} style={[styles.answerCard, { borderColor: colors.primary }]}>
            <View style={styles.answerHead}>
              <Text style={[text.label, { color: colors.primary, flex: 1 }]}>
                Already answered
              </Text>
              <View style={[styles.ageTag, { borderColor: ageTone(cached.ageHours) }]}>
                <Text style={[text.dataMedium, { color: ageTone(cached.ageHours) }]}>
                  {cached.ageLabel ?? `${cached.ageHours}h ago`}
                </Text>
              </View>
            </View>

            <Text style={[styles.answerText, { color: colors.foreground }]}>{cached.answer}</Text>
            <Text style={[text.body, { color: colors.mutedForeground }]}>{cached.detail}</Text>

            <View style={styles.answerMeta}>
              <View style={[styles.avatar, { backgroundColor: colors.sunken }]}>
                <Text style={[text.dataMedium, { color: colors.foreground }]}>
                  {cached.verifierInitials}
                </Text>
              </View>
              <Text style={[text.bodySmall, { color: colors.mutedForeground, flex: 1 }]}>
                {cached.verifierName} went and checked · {cached.proof} proof
                {cached.confirmed ? ' · confirmed by the asker' : ' · not confirmed'}
              </Text>
            </View>

            {tipped > 0 ? (
              <View style={[styles.tipDone, { borderColor: colors.primary }]}>
                <Ionicons name="checkmark-circle" size={16} color={colors.primary} />
                <Text style={[text.subheading, { color: colors.primary, flex: 1 }]}>
                  ₦{formatNaira(tipped)} tipped to {cached.verifierName}
                </Text>
              </View>
            ) : (
              <>
                <View style={styles.tipRow}>
                  <Text style={[text.data, { color: colors.faintForeground }]}>Tip</Text>
                  {TIP_PRESETS.map((amount) => (
                    <Pressable
                      key={amount}
                      onPress={() => sendTip(amount, cached.verifierName)}
                      style={({ pressed }) => [
                        styles.tipBtn,
                        { borderColor: colors.borderStrong, opacity: pressed ? 0.6 : 1 },
                      ]}
                    >
                      <Text style={[text.dataMedium, { color: colors.foreground }]}>
                        ₦{amount}
                      </Text>
                    </Pressable>
                  ))}
                  <Pressable
                    onPress={() => {
                      setTipCustom(true);
                      setTipDraft('');
                      requestAnimationFrame(() => tipRef.current?.focus());
                    }}
                    style={({ pressed }) => [
                      styles.tipBtn,
                      {
                        borderColor: tipCustom ? colors.foreground : colors.borderStrong,
                        backgroundColor: tipCustom ? colors.foreground : 'transparent',
                        opacity: pressed ? 0.6 : 1,
                      },
                    ]}
                  >
                    <Text
                      style={[
                        text.dataMedium,
                        { color: tipCustom ? colors.background : colors.foreground },
                      ]}
                    >
                      Custom
                    </Text>
                  </Pressable>
                </View>

                {tipCustom && (
                  <View style={styles.tipCustomRow}>
                    <View style={[styles.tipField, { borderColor: colors.borderStrong }]}>
                      <Text style={[styles.tipSymbol, { color: colors.foreground }]}>₦</Text>
                      <TextInput
                        ref={tipRef}
                        style={[styles.tipInput, { color: colors.foreground }]}
                        value={tipDraft}
                        onChangeText={(v) => setTipDraft(v.replace(/\D/g, '').slice(0, 6))}
                        keyboardType="numeric"
                        inputAccessoryViewID={
                          Platform.OS === 'ios' ? NUMERIC_ACCESSORY_ID : undefined
                        }
                        placeholder="500"
                        placeholderTextColor={colors.faintForeground}
                      />
                      {/* Never let the converted figure be the thing that
                          gets squeezed — a half-rendered price is worse than
                          no price, so the naira field yields instead. */}
                      <Text
                        style={[text.data, styles.tipUsd, { color: colors.faintForeground }]}
                        numberOfLines={1}
                      >
                        ${toUsd(tipDraftValue, rate)}
                      </Text>
                    </View>

                    <Pressable
                      onPress={() => sendTip(tipDraftValue, cached.verifierName)}
                      disabled={!tipDraftValid}
                      style={({ pressed }) => [
                        styles.tipConfirm,
                        {
                          backgroundColor: tipDraftValid ? colors.primary : colors.sunken,
                          opacity: pressed ? 0.85 : 1,
                        },
                      ]}
                    >
                      <Text
                        style={[
                          text.action,
                          {
                            color: tipDraftValid
                              ? colors.primaryForeground
                              : colors.faintForeground,
                          },
                        ]}
                      >
                        Send
                      </Text>
                    </Pressable>
                  </View>
                )}
              </>
            )}

            <Pressable
              onPress={() => {
                pendingScroll.current = true;
                setState('needs_verification');
              }}
              style={({ pressed }) => [
                styles.recheckBtn,
                { borderColor: colors.accent, opacity: pressed ? 0.7 : 1 },
              ]}
            >
              <Ionicons name="refresh" size={15} color={colors.accent} />
              <Text style={[text.action, { color: colors.accent }]}>Send someone anyway</Text>
            </Pressable>
          </View>
        )}

        {state === 'needs_verification' && (
          <View
            onLayout={revealResult}
            style={[
              styles.dispatchCard,
              { backgroundColor: colors.accentSoft, borderColor: colors.accent },
            ]}
          >
            {/*
              * The agent's finding, not a slogan.
              *
              * This read "No reliable answer online", which was a claim about
              * a search nothing performed — and it was identical whether the
              * place had never been visited or had been checked half an hour
              * ago and judged stale. Those are different things and the person
              * paying is entitled to know which one applies.
              */}
            <Text style={[text.label, { color: colors.accent }]}>
              {reason ? 'What the check found' : 'Nothing recent to go on'}
            </Text>
            {reason && (
              <Text style={[text.body, { color: colors.foreground, marginTop: 2 }]}>{reason}</Text>
            )}
            <Text style={[text.title, styles.dispatchTitle, { color: colors.foreground }]}>
              Someone has to go and look.
            </Text>
            {/* Not "we will send someone" — nobody is dispatched. The job is
                offered, and whoever takes it first is the one who goes. */}
            <Text style={[text.body, { color: colors.mutedForeground }]}>
              Your question goes to people nearby. Whoever takes it first sends photo or video
              proof.
            </Text>

            <View style={[styles.dispatchFacts, { borderColor: colors.accent + '55' }]}>
              {[
                { k: 'Where', v: place?.name ?? 'Not set' },
                { k: 'Area', v: areaLine },
                { k: 'Answer within', v: formatDuration(deadlineValue || DEFAULT_DEADLINE) },
              ].map((f, i) => (
                <View
                  key={f.k}
                  style={[
                    styles.factRow,
                    i > 0 && { borderTopWidth: 1, borderTopColor: colors.accent + '33' },
                  ]}
                >
                  <Text style={[text.bodySmall, { color: colors.mutedForeground }]}>{f.k}</Text>
                  <Text
                    style={[text.dataMedium, { color: colors.foreground, flex: 1, textAlign: 'right' }]}
                    numberOfLines={1}
                  >
                    {f.v}
                  </Text>
                </View>
              ))}
            </View>

            {/* ── What you will pay ────────────────────────────────
                Asked only here. Up to this point nothing has cost anything,
                and most questions never get this far. */}
            <View style={[styles.bountyBox, { borderColor: colors.accent + '55' }]}>
              <View style={styles.bountyTop}>
                <View style={{ flex: 1 }}>
                  <Text style={[text.label, { color: colors.accent }]}>What will you pay?</Text>
                  <View style={styles.bountyFieldRow}>
                    <Text style={[styles.bountySymbol, { color: colors.foreground }]}>₦</Text>
                    <TextInput
                      ref={bountyRef}
                      style={[styles.bountyField, { color: colors.foreground }]}
                      value={bounty}
                      onChangeText={(v) => setBounty(v.replace(/\D/g, '').slice(0, 6))}
                      keyboardType="numeric"
                      inputAccessoryViewID={
                        Platform.OS === 'ios' ? NUMERIC_ACCESSORY_ID : undefined
                      }
                      placeholder="500"
                      placeholderTextColor={colors.faintForeground}
                      selectTextOnFocus
                    />
                  </View>
                </View>

                {/* The dollar figure and the rate behind it. A converted
                    number nobody can check is worse than none at all. */}
                <View style={styles.usdCol}>
                  <Text style={[text.amount, { color: colors.money, fontSize: 18 }]}>
                    ${toUsd(bountyValue, rate)}
                  </Text>
                  <Text style={[text.data, { color: colors.faintForeground }]}>
                    at ₦{formatNaira(Math.round(rate))}/$1
                  </Text>
                </View>
              </View>

              <View style={styles.presetRow}>
                {BOUNTY_PRESETS.map((amount) => {
                  const on = bountyValue === amount;
                  return (
                    <Pressable
                      key={amount}
                      onPress={() => setBounty(String(amount))}
                      style={[
                        styles.preset,
                        {
                          backgroundColor: on ? colors.foreground : 'transparent',
                          borderColor: on ? colors.foreground : colors.borderStrong,
                        },
                      ]}
                    >
                      <Text
                        style={[
                          text.dataMedium,
                          { color: on ? colors.background : colors.foreground },
                        ]}
                      >
                        ₦{formatNaira(amount)}
                      </Text>
                    </Pressable>
                  );
                })}

                <Pressable
                  onPress={() => {
                    setBounty('');
                    bountyRef.current?.focus();
                  }}
                  style={[
                    styles.preset,
                    {
                      backgroundColor: isCustom ? colors.foreground : 'transparent',
                      borderColor: isCustom ? colors.foreground : colors.borderStrong,
                    },
                  ]}
                >
                  <Text
                    style={[
                      text.dataMedium,
                      { color: isCustom ? colors.background : colors.foreground },
                    ]}
                  >
                    Custom
                  </Text>
                </Pressable>
              </View>

              <Text
                style={[
                  text.data,
                  { color: bountyValid ? colors.faintForeground : colors.danger, marginTop: 10 },
                ]}
              >
                {bountyValid
                  ? `${pickupHint(bountyValue)} · verifier keeps ₦${formatNaira(verifierCut(bountyValue))}`
                  : `At least ₦${formatNaira(MIN_BOUNTY)}`}
              </Text>

              {/* ── How long they get ──────────────────────────────
                  A deadline is what makes the money refundable: without
                  one there is no moment at which nobody has delivered. */}
              <View style={[styles.visRow, { borderTopColor: colors.accent + '33' }]}>
                <View style={{ flex: 1 }}>
                  <Text style={[text.subheading, { color: colors.foreground }]}>
                    Answer within
                  </Text>
                  <Text style={[text.data, { color: colors.faintForeground }]}>
                    Close it for a full refund if nobody delivers in time
                  </Text>
                </View>
              </View>

              <View style={styles.presetRow}>
                {DEADLINE_PRESETS.map((minutes) => {
                  const on = deadlineValue === minutes;
                  return (
                    <Pressable
                      key={minutes}
                      onPress={() => setDeadline(String(minutes))}
                      style={[
                        styles.preset,
                        {
                          backgroundColor: on ? colors.foreground : 'transparent',
                          borderColor: on ? colors.foreground : colors.borderStrong,
                        },
                      ]}
                    >
                      <Text
                        style={[
                          text.dataMedium,
                          { fontSize: 11, color: on ? colors.background : colors.foreground },
                        ]}
                      >
                        {formatDuration(minutes)}
                      </Text>
                    </Pressable>
                  );
                })}

                <Pressable
                  onPress={() => {
                    setDeadline('');
                    deadlineRef.current?.focus();
                  }}
                  style={[
                    styles.preset,
                    {
                      backgroundColor: isCustomDeadline ? colors.foreground : 'transparent',
                      borderColor: isCustomDeadline ? colors.foreground : colors.borderStrong,
                    },
                  ]}
                >
                  <Text
                    style={[
                      text.dataMedium,
                      { fontSize: 11, color: isCustomDeadline ? colors.background : colors.foreground },
                    ]}
                  >
                    Custom
                  </Text>
                </Pressable>
              </View>

              {isCustomDeadline && (
                <View style={[styles.deadlineField, { borderColor: colors.borderStrong }]}>
                  <TextInput
                    ref={deadlineRef}
                    style={[styles.deadlineInput, { color: colors.foreground }]}
                    value={deadline}
                    onChangeText={(v) => setDeadline(v.replace(/\D/g, '').slice(0, 5))}
                    keyboardType="numeric"
                    inputAccessoryViewID={
                      Platform.OS === 'ios' ? NUMERIC_ACCESSORY_ID : undefined
                    }
                    placeholder="45"
                    placeholderTextColor={colors.faintForeground}
                  />
                  <Text style={[text.data, { color: colors.faintForeground }]}>minutes</Text>
                </View>
              )}

              {!deadlineValid && (
                <Text style={[text.data, { color: colors.danger, marginTop: 8 }]}>
                  Between {formatDuration(MIN_DEADLINE)} and {formatDuration(MAX_DEADLINE)}
                </Text>
              )}

              {/* ── Who may take it ────────────────────────────────── */}
              <View style={[styles.visRow, { borderTopColor: colors.accent + '33' }]}>
                <View style={{ flex: 1 }}>
                  <Text style={[text.subheading, { color: colors.foreground }]}>
                    Verified people only
                  </Text>
                  <Text style={[text.data, { color: colors.faintForeground }]}>
                    {verifiedForced
                      ? `Required above ₦${formatNaira(VERIFIED_ONLY_ABOVE)}`
                      : verifiedOn
                        ? 'Only people who confirmed their identity can take it'
                        : 'Anyone nearby can take it'}
                  </Text>
                </View>
                <Pressable
                  onPress={() => !verifiedForced && setVerifiedOnly(!verifiedOnly)}
                  disabled={verifiedForced}
                  accessibilityRole="switch"
                  accessibilityState={{ checked: verifiedOn, disabled: verifiedForced }}
                  style={[
                    styles.toggle,
                    {
                      backgroundColor: verifiedOn ? colors.primary : colors.sunken,
                      borderColor: verifiedOn ? colors.primary : colors.borderStrong,
                      opacity: verifiedForced ? 0.6 : 1,
                    },
                  ]}
                >
                  <View
                    style={[
                      styles.knob,
                      {
                        backgroundColor: verifiedOn
                          ? colors.primaryForeground
                          : colors.mutedForeground,
                        alignSelf: verifiedOn ? 'flex-end' : 'flex-start',
                      },
                    ]}
                  />
                </Pressable>
              </View>

              {/* ── Who else may see the answer ────────────────────── */}
              <View style={[styles.visRow, { borderTopColor: colors.accent + '33' }]}>
                <View style={{ flex: 1 }}>
                  <Text style={[text.subheading, { color: colors.foreground }]}>
                    Share the answer
                  </Text>
                  <Text style={[text.data, { color: colors.faintForeground }]}>
                    {visibility === 'public'
                      ? 'Others asking about this place can see it'
                      : 'Only you will ever see it'}
                  </Text>
                </View>
                <Pressable
                  onPress={() => setVisibility(visibility === 'public' ? 'private' : 'public')}
                  accessibilityRole="switch"
                  accessibilityState={{ checked: visibility === 'public' }}
                  style={[
                    styles.toggle,
                    {
                      backgroundColor: visibility === 'public' ? colors.primary : colors.sunken,
                      borderColor: visibility === 'public' ? colors.primary : colors.borderStrong,
                    },
                  ]}
                >
                  <View
                    style={[
                      styles.knob,
                      {
                        backgroundColor:
                          visibility === 'public' ? colors.primaryForeground : colors.mutedForeground,
                        alignSelf: visibility === 'public' ? 'flex-end' : 'flex-start',
                      },
                    ]}
                  />
                </Pressable>
              </View>
            </View>

            {shortfallNaira > 0 && (
              <Pressable
                onPress={() => router.push('/(tabs)/you')}
                style={({ pressed }) => [
                  styles.shortfall,
                  { borderColor: colors.pending, opacity: pressed ? 0.8 : 1 },
                ]}
              >
                <Ionicons name="wallet-outline" size={15} color={colors.pending} />
                <Text style={[text.bodySmall, { color: colors.pending, flex: 1 }]}>
                  About ₦{formatNaira(shortfallNaira)} short. Top up to send this.
                </Text>
                <Ionicons name="chevron-forward" size={15} color={colors.pending} />
              </Pressable>
            )}

            <Pressable
              onPress={handleDispatch}
              disabled={!bountyValid || !deadlineValid}
              style={({ pressed }) => [
                styles.dispatchBtn,
                {
                  backgroundColor: readyToSend ? colors.accent : colors.sunken,
                  opacity: pressed ? 0.88 : 1,
                },
              ]}
            >
              <Text
                style={[
                  text.action,
                  {
                    color: readyToSend ? colors.accentForeground : colors.faintForeground,
                  },
                ]}
              >
                {!bountyValid || !deadlineValid
                  ? `Send someone · ₦${formatNaira(bountyValue)}`
                  : usdcBalance === null
                    ? 'Checking your balance'
                    : canAfford
                      ? `Send someone · ₦${formatNaira(bountyValue)}`
                      : 'Not enough in your wallet'}
              </Text>
              {/* Spinner while the balance is still unknown, so the wait
                  reads as work rather than a stuck button. */}
              {usdcBalance === null && bountyValid && deadlineValid ? (
                <ActivityIndicator size="small" color={colors.faintForeground} />
              ) : (
                <Ionicons
                  name="arrow-forward"
                  size={16}
                  color={readyToSend ? colors.accentForeground : colors.faintForeground}
                />
              )}
            </Pressable>
          </View>
        )}
      </KeyboardAwareScrollViewCompat>

      {/* ── Before the money moves ─────────────────────────────────
          Sending is irreversible in the sense that matters: the bounty leaves
          the wallet immediately. Said plainly, along with the two things
          people actually want to know — when it is released, and what happens
          if nobody goes. */}
      {/*
        * Held open for the whole attempt: two wallet dialogs and a relayed
        * transaction. Not dismissable, because there is nothing useful a tap
        * could do to a signature already in front of somebody — and a backdrop
        * that closes would look like a way to cancel something it cannot.
        */}
      <Modal visible={sending} transparent animationType="fade">
        <View style={[styles.confirmBackdrop, { backgroundColor: colors.overlay }]}>
          <View
            style={{
              backgroundColor: colors.surface,
              borderColor: colors.border,
              borderWidth: 2,
              borderRadius: 2,
              paddingVertical: 22,
              paddingHorizontal: 20,
              width: '86%',
              maxWidth: 380,
              gap: 12,
            }}
          >
            <SendingIndicator label="Locking the bounty" color={colors.accent} />
            <Text style={[text.bodySmall, { color: colors.faintForeground }]}>
              Approve it in your wallet. Nothing is sent until that is done.
            </Text>
          </View>
        </View>
      </Modal>

      <Modal
        visible={confirmOpen}
        transparent
        animationType="fade"
        onRequestClose={() => setConfirmOpen(false)}
      >
        <Pressable
          style={[styles.confirmBackdrop, { backgroundColor: colors.overlay }]}
          onPress={() => setConfirmOpen(false)}
        >
          <Pressable
            onPress={(e) => e.stopPropagation()}
            style={[
              styles.confirmCard,
              { backgroundColor: colors.background, borderColor: colors.accent },
            ]}
          >
            <Text style={[text.label, { color: colors.accent }]}>Before you send</Text>
            <Text style={[text.title, { color: colors.foreground, marginTop: 6 }]}>
              ₦{formatNaira(bountyValue)} leaves your wallet now
            </Text>

            <View style={[styles.confirmList, { borderColor: colors.border }]}>
              {[
                {
                  icon: 'lock-closed-outline' as const,
                  tone: colors.pending,
                  text: 'It is held safely, not paid to anyone yet.',
                },
                {
                  icon: 'checkmark-circle-outline' as const,
                  tone: colors.primary,
                  text: `Whoever goes is paid ₦${formatNaira(verifierCut(bountyValue))} only after you see their photo or video and accept it.`,
                },
                {
                  icon: 'arrow-undo-outline' as const,
                  tone: colors.money,
                  text: `If nobody goes within ${formatDuration(deadlineValue)}, you take the full ₦${formatNaira(bountyValue)} back.`,
                },
                {
                  icon: 'people-outline' as const,
                  tone: colors.mutedForeground,
                  text: 'If you disagree with what comes back, support reviews both sides before anything is decided.',
                },
              ].map((row) => (
                <View key={row.text} style={styles.confirmRow}>
                  <Ionicons name={row.icon} size={16} color={row.tone} />
                  <Text style={[text.bodySmall, { color: colors.foreground, flex: 1 }]}>
                    {row.text}
                  </Text>
                </View>
              ))}
            </View>

            <Pressable
              onPress={confirmDispatch}
              disabled={checking}
              style={({ pressed }) => [
                styles.confirmGo,
                {
                  backgroundColor: colors.accent,
                  opacity: pressed || checking ? 0.88 : 1,
                },
              ]}
            >
              {checking ? (
                <View style={styles.confirmBusy}>
                  <ActivityIndicator size="small" color={colors.accentForeground} />
                  <Text style={[text.action, { color: colors.accentForeground }]}>
                    Checking your balance
                  </Text>
                </View>
              ) : (
                <Text style={[text.action, { color: colors.accentForeground }]}>
                  Send it · ₦{formatNaira(bountyValue)}
                </Text>
              )}
            </Pressable>

            {/* Kept out of the way mid-check: cancelling while a read is in
                flight would leave the result arriving against a closed sheet. */}
            <Pressable
              onPress={() => setConfirmOpen(false)}
              disabled={checking}
              style={styles.confirmBack}
            >
              <Text
                style={[
                  text.action,
                  { color: checking ? colors.faintForeground : colors.mutedForeground },
                ]}
              >
                Not yet
              </Text>
            </Pressable>
          </Pressable>
        </Pressable>
      </Modal>

      <PlacePicker
        visible={pickerOpen}
        onClose={() => setPickerOpen(false)}
        onSelect={(chosen) => {
          setPlace(chosen);
          setPickerOpen(false);
        }}
      />

      {/* iOS hosts this over the keypad rather than in the layout, and only on
          iOS: Android has no such view and would render it inline, mid-screen.
          Shared by every numeric field on this screen — only one keypad can be
          up at a time, so one bar serves them all. */}
      {Platform.OS === 'ios' && (
        <InputAccessoryView nativeID={NUMERIC_ACCESSORY_ID}>
          <View
            style={[
              styles.accessoryBar,
              { backgroundColor: colors.surface, borderTopColor: colors.border },
            ]}
          >
            <Pressable onPress={() => Keyboard.dismiss()} hitSlop={10}>
              <Text style={[text.action, { color: colors.accent }]}>Done</Text>
            </Pressable>
          </View>
        </InputAccessoryView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  hereCard: { marginTop: 10, borderWidth: 2, borderRadius: 2 },
  hereHead: { flexDirection: 'row', alignItems: 'center', gap: 8, padding: 11 },
  hereRow: { borderTopWidth: 2, paddingHorizontal: 11, paddingVertical: 9 },

  screen: { flex: 1 },
  scroll: { paddingHorizontal: 20, paddingBottom: 36 },

  masthead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 14,
  },
  mastheadRight: { flexDirection: 'row', gap: 8 },
  ghostBtn: {
    width: 36,
    height: 36,
    borderRadius: 2,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  bellDot: {
    position: 'absolute',
    top: -3,
    right: -3,
    width: 10,
    height: 10,
    borderRadius: 2,
    borderWidth: 2,
  },

  // Two readings side by side rather than one run-on sentence: a count is
  // something you glance at, so the numeral leads and the label sits beside
  // it on the same line, the way a gauge is annotated.
  board: { flexDirection: 'row', borderWidth: 2, borderRadius: 2 },
  boardCell: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    paddingHorizontal: 12,
    paddingVertical: 12,
  },
  boardDivider: { width: 2 },
  reading: { fontFamily: font.monoBold, fontSize: 24, lineHeight: 27, letterSpacing: -0.8 },
  cellLabel: {
    flex: 1,
    fontFamily: font.monoSemi,
    fontSize: 9.5,
    lineHeight: 12,
    letterSpacing: 0.9,
    textTransform: 'uppercase',
  },
  confirmBackdrop: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 22 },
  confirmCard: { width: '100%', maxWidth: 380, borderWidth: 2, borderRadius: 2, padding: 20 },
  confirmList: { borderWidth: 2, borderRadius: 2, padding: 14, gap: 12, marginTop: 16 },
  confirmRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
  confirmGo: { borderRadius: 2, paddingVertical: 15, alignItems: 'center', marginTop: 18 },
  confirmBack: { paddingVertical: 13, alignItems: 'center' },
  liveDot: { width: 7, height: 7, borderRadius: 2 },

  greeting: { marginTop: 26 },
  headline: { marginTop: 6, marginBottom: 22 },

  composer: { borderWidth: 2, borderRadius: 2, overflow: 'hidden' },
  composerInput: {
    fontSize: 17,
    lineHeight: 24,
    paddingLeft: 16,
    // Room for the wand so long questions never run underneath it.
    paddingRight: 46,
    paddingTop: 16,
    paddingBottom: 14,
    minHeight: 92,
    textAlignVertical: 'top',
  },
  wandBtn: { position: 'absolute', top: 13, right: 12, padding: 2 },
  askHint: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 10 },

  bountyBox: { borderWidth: 2, borderRadius: 2, padding: 14, marginTop: 12 },
  bountyTop: { flexDirection: 'row', alignItems: 'flex-start', gap: 12 },
  bountyFieldRow: { flexDirection: 'row', alignItems: 'center', gap: 3, marginTop: 3 },
  bountySymbol: { fontFamily: font.monoBold, fontSize: 24 },
  bountyField: { fontFamily: font.monoBold, fontSize: 24, minWidth: 90, padding: 0 },
  usdCol: { alignItems: 'flex-end', gap: 2, paddingTop: 14 },
  presetRow: { flexDirection: 'row', gap: 7, marginTop: 12 },
  preset: {
    flex: 1,
    alignItems: 'center',
    borderWidth: 2,
    borderRadius: 2,
    paddingVertical: 8,
  },
  visRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    borderTopWidth: 1,
    marginTop: 14,
    paddingTop: 13,
  },
  toggle: { width: 46, height: 26, borderWidth: 2, borderRadius: 2, padding: 2 },
  knob: { width: 18, height: 18, borderRadius: 1 },

  answerCard: { borderWidth: 2, borderRadius: 2, padding: 18, marginTop: 16, gap: 10 },
  answerHead: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  ageTag: { borderWidth: 2, borderRadius: 2, paddingHorizontal: 8, paddingVertical: 3 },
  answerText: { fontFamily: font.sansBold, fontSize: 21, lineHeight: 27 },
  answerMeta: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  avatar: {
    width: 30,
    height: 30,
    borderRadius: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  tipRow: { flexDirection: 'row', alignItems: 'center', gap: 7, marginTop: 2, flexWrap: 'wrap' },
  tipBtn: { borderWidth: 2, borderRadius: 2, paddingHorizontal: 12, paddingVertical: 8 },
  tipCustomRow: { flexDirection: 'row', alignItems: 'stretch', gap: 8, marginTop: 8 },
  tipField: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderWidth: 2,
    borderRadius: 2,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  tipSymbol: { fontFamily: font.monoBold, fontSize: 16, flexShrink: 0 },
  tipInput: { flex: 1, minWidth: 40, fontFamily: font.monoBold, fontSize: 16, padding: 0 },
  tipUsd: { flexShrink: 0 },
  deadlineField: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderWidth: 2,
    borderRadius: 2,
    paddingHorizontal: 12,
    paddingVertical: 10,
    marginTop: 8,
  },
  deadlineInput: { flex: 1, fontFamily: font.monoBold, fontSize: 16, padding: 0 },
  tipConfirm: {
    justifyContent: 'center',
    borderRadius: 2,
    paddingHorizontal: 18,
  },
  tipDone: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderWidth: 2,
    borderRadius: 2,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  recheckBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    borderWidth: 2,
    borderRadius: 2,
    paddingVertical: 14,
    marginTop: 4,
  },
  composerFoot: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderTopWidth: 2,
    paddingLeft: 14,
    paddingRight: 8,
    paddingVertical: 8,
  },
  placeChip: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderWidth: 2,
    borderRadius: 2,
    paddingHorizontal: 9,
    paddingVertical: 8,
  },
  sendBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 2,
  },

  sectionLabel: { marginTop: 32, marginBottom: 12 },
  feedHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 32,
    marginBottom: 12,
  },
  suggestBox: { marginTop: 14 },
  suggestHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 10,
  },
  prompt: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    borderWidth: 2,
    borderRadius: 2,
    paddingHorizontal: 15,
    paddingVertical: 13,
    marginBottom: 8,
  },

  viewAll: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    borderWidth: 2,
    borderRadius: 2,
    paddingVertical: 12,
    marginTop: 2,
  },

  recentList: { gap: 0 },
  recentRow: { paddingVertical: 15, borderBottomWidth: 1 },
  recentMeta: { flexDirection: 'row', alignItems: 'center', gap: 5 },

  askedBack: { marginBottom: 22 },
  tracePanel: { borderWidth: 2, borderRadius: 2, padding: 20 },

  dispatchCard: { marginTop: 16, borderWidth: 2, borderRadius: 2, padding: 20, gap: 10 },
  dispatchTitle: { marginTop: 2 },
  dispatchFacts: { borderWidth: 2, borderRadius: 2, marginTop: 6 },
  factRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    paddingHorizontal: 14,
    paddingVertical: 11,
  },
  shortfall: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 9,
    borderWidth: 2,
    borderRadius: 2,
    padding: 12,
    marginBottom: 10,
  },
  confirmBusy: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  accessoryBar: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    alignItems: 'center',
    borderTopWidth: 2,
    paddingHorizontal: 20,
    paddingVertical: 11,
  },
  dispatchBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    borderRadius: 2,
    paddingVertical: 15,
    marginTop: 6,
  },
});
