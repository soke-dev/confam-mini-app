import React, { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Linking,
  Animated,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { router, useLocalSearchParams } from 'expo-router';
import * as Haptics from 'expo-haptics';
import * as ImagePicker from 'expo-image-picker';
import { manipulateAsync, SaveFormat } from 'expo-image-manipulator';
import * as Location from 'expo-location';
import { Image } from 'expo-image';
import { useColors } from '@/hooks/useColors';
import { taskPhase } from '@/utils/taskPhase';
import { useDialog } from '@/contexts/DialogContext';
import { useNow } from '@/hooks/useNow';
import { font, text } from '@/constants/type';
import { insecurePage } from '@/utils/secureContext';
import { whereAmI } from '@/utils/whereAmI';
import { useApp } from '@/contexts/AppContext';
import { submitAnswer, takenJobs } from '@/utils/questionsApi';
import { claimJob, escrowAvailable } from '@/utils/escrowApi';
import { useSignAuthorization } from '@/utils/privy';
import { FEE_PERCENT, PLATFORM_FEE } from '@/constants/money';
import { hasApi } from '@/utils/api';
import { MAX_ATTEMPTS, distanceMetres, runEvidenceGate, type EvidenceCheck, type EvidenceReport } from '@/utils/evidenceChecks';
import { KeyboardAwareScrollViewCompat } from '@/components/KeyboardAwareScrollViewCompat';

type PageState =
  | 'detail'
  | 'locating'
  | 'countdown'
  | 'form'
  | 'ai_checking'
  | 'check_result'
  | 'pending_asker'
  /** The asker objected. Nothing to do but reply and wait for a reviewer. */
  | 'queried'
  | 'earned';
type MediaChoice = 'photo' | 'video' | null;

/** One captured file. `seconds` is set for video only. */
type Shot = { uri: string; seconds?: number };

/** Enough angles to prove a scene without turning review into a slideshow. */
const MAX_PHOTOS = 5;
/** Matches videoMaxDuration, and re-checked because that only caps recording. */
const MAX_VIDEO_SECONDS = 30;

type CaptureTip = {
  icon: keyof typeof Ionicons.glyphMap;
  lead: string;
  body: string;
  /** The one rule that matters most; highlighted. */
  key?: boolean;
};

const CAPTURE_TIPS: Record<'photo' | 'video', CaptureTip[]> = {
  video: [
    {
      icon: 'mic-outline',
      lead: 'Say today’s date and time first.',
      body: 'Out loud, before anything else. It proves the clip is from today.',
      key: true,
    },
    {
      icon: 'walk-outline',
      lead: 'Pan slowly across what you are showing.',
      body: 'Steady, left to right. Do not rush it.',
    },
    {
      icon: 'chatbox-ellipses-outline',
      lead: 'Say what you are seeing.',
      body: 'Prices, how many people, whether it is open.',
    },
    {
      icon: 'timer-outline',
      lead: 'Keep it under 30 seconds.',
      body: 'The camera stops there. Long clips are slow to upload and slow to review.',
    },
  ],
  photo: [
    {
      icon: 'scan-outline',
      lead: 'Get the whole thing in frame.',
      body: 'The queue, the sign, the price board — not just a corner.',
    },
    {
      icon: 'eye-outline',
      lead: 'Hold still until it is sharp.',
      body: 'A blurred photo gets queried and you do not get paid.',
    },
    {
      icon: 'sunny-outline',
      lead: 'Watch the light.',
      body: 'Avoid shooting into the sun or through glare.',
    },
    {
      icon: 'business-outline',
      lead: 'Include something that names the place.',
      body: 'A signboard or shopfront proves where you were.',
    },
  ],
};

function clock(s: number) {
  return `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, '0')}`;
}

function tap(style: Haptics.ImpactFeedbackStyle = Haptics.ImpactFeedbackStyle.Medium) {
  if (Platform.OS !== 'web') Haptics.impactAsync(style);
}

function Breath({ children }: { children: React.ReactNode }) {
  const scale = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    const anim = Animated.loop(
      Animated.sequence([
        Animated.timing(scale, { toValue: 1.06, duration: 750, useNativeDriver: true }),
        Animated.timing(scale, { toValue: 1, duration: 750, useNativeDriver: true }),
      ]),
    );
    anim.start();
    return () => anim.stop();
  }, [scale]);
  return <Animated.View style={{ transform: [{ scale }] }}>{children}</Animated.View>;
}

/**
 * One line of the gate's report.
 *
 * A skipped check is drawn differently from a passed one on purpose. "We did
 * not look at this" and "we looked and it was fine" are different facts, and
 * collapsing them into a single tick is how a verifier ends up believing their
 * evidence was vetted when nothing examined it.
 */
function CheckRow({
  check,
  colors,
}: {
  check: EvidenceCheck;
  colors: ReturnType<typeof useColors>;
}) {
  const look = {
    pass: { icon: 'checkmark-circle' as const, tint: colors.primary },
    warn: { icon: 'alert-circle' as const, tint: colors.pending },
    fail: { icon: 'close-circle' as const, tint: colors.danger },
    skipped: { icon: 'remove-circle-outline' as const, tint: colors.faintForeground },
  }[check.verdict];

  return (
    <View style={[styles.checkRow, { borderBottomColor: colors.border }]}>
      <Ionicons name={look.icon} size={17} color={look.tint} />
      <Text style={[text.bodySmall, { color: colors.foreground, flex: 1 }]}>{check.detail}</Text>
    </View>
  );
}

export default function TaskScreen() {
  const colors = useColors();
  const { confirm, notify } = useDialog();
  const insets = useSafeAreaInsets();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { nearbyTasks, myJobs, acceptTask, abandonTask, identity, queries } = useApp();
  const topPad = Platform.OS === 'web' ? 22 : insets.top + 6;

  /**
   * Looked up in both lists.
   *
   * A job leaves `nearbyTasks` the moment it is accepted — /questions/nearby
   * only returns what is still open — so reading that list alone showed "this
   * job is gone" to the one person who had just taken it.
   */
  /**
   * The taken copy first, the open board second.
   *
   * Both lists can hold the same job for a moment after it is accepted, but
   * only the taken copy carries `taskId` — /questions/nearby has no task to
   * report. Searching the board first meant the job was always found without
   * one, so evidence was checked and never filed against anything.
   */
  const task = myJobs.find((t) => t.id === id) ?? nearbyTasks.find((t) => t.id === id);

  /**
   * Where to open, from what the server says has already happened.
   *
   * A submitted job used to land back on the accept screen, asking somebody to
   * go and do a job they had already done — and offering them the chance to
   * submit a second time.
   */
  const [pageState, setPageState] = useState<PageState>('detail');

  /**
   * Corrects the screen once the job actually loads.
   *
   * The state cannot be worked out at first render — `myJobs` arrives from the
   * server a moment later — so an initialiser ran against an undefined task,
   * settled on the accept screen, and stayed there. A verifier who had already
   * submitted was asked to go and do the job again.
   *
   * Only ever moves forward, and only from `detail`: somebody midway through
   * capturing must not be yanked elsewhere by a poll landing.
   */
  const alignedFor = useRef<string | null>(null);

  useEffect(() => {
    const status = task?.serverStatus;
    if (!status || pageState !== 'detail') return;
    if (alignedFor.current === `${id}:${status}`) return;
    alignedFor.current = `${id}:${status}`;

    /**
     * Every phase gets a destination, so a status this switch has not met
     * cannot quietly land on the evidence form. That is precisely how a
     * queried job came to ask the verifier to photograph the place twice.
     */
    switch (taskPhase(status)) {
      case 'settled':
        setPageState('earned');
        break;
      case 'delivered':
        setPageState('pending_asker');
        break;
      case 'queried':
        setPageState('queried');
        break;
      case 'working':
        setPageState('form');
        break;
      // 'open' and 'expired' are not this screen's to move: the job is not
      // theirs any more, and the detail view says so on its own.
      default:
        break;
    }
  }, [task?.serverStatus, pageState, id]);
  /**
   * Remaining time is always `expiresAt - now`, so reopening the screen cannot
   * restart it. The clock comes from a shared hook rather than a local
   * counter, which is what used to reset.
   */
  const now = useNow(task?.expiresAt);
  const [startIn, setStartIn] = useState(30);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [deliverError, setDeliverError] = useState<string | null>(null);
  const signAuthorization = useSignAuthorization();
  const [media, setMedia] = useState<MediaChoice>(null);
  const [shots, setShots] = useState<Shot[]>([]);
  const [tipsOpen, setTipsOpen] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [watchers, setWatchers] = useState(task?.viewersCount ?? 3);
  const [place, setPlace] = useState('');
  const [coords, setCoords] = useState<{ lat: number; lng: number } | null>(null);
  const [report, setReport] = useState<EvidenceReport | null>(null);
  const [attempt, setAttempt] = useState(0);

  const msLeft = Math.max(0, (task?.expiresAt ?? 0) - now);

  useEffect(() => {
    if (pageState !== 'detail') return;
    const t = setInterval(
      () => setWatchers((v) => Math.max(1, v + (Math.random() > 0.5 ? -1 : 1))),
      2500,
    );
    return () => clearInterval(t);
  }, [pageState]);

  /**
   * The window is a commitment, not a delay before the camera.
   *
   * Running out used to open the evidence form by itself — so a job nobody had
   * confirmed they were walking to stayed locked to them for the whole
   * deadline while the asker waited on somebody who might have put their phone
   * down. Not confirming now gives the job back, which is what "if you do not
   * start in time" on the screen above has always said it would do.
   */
  useEffect(() => {
    if (pageState !== 'countdown') return;

    if (startIn <= 0) {
      void (async () => {
        await abandonTask(task!.id);
        await notify({
          title: 'Job released',
          message: 'You did not confirm in time, so it has gone back to the board for somebody else.',
        });
        router.replace('/(tabs)/earn');
      })();
      return;
    }

    const t = setInterval(() => setStartIn((c) => c - 1), 1000);
    return () => clearInterval(t);
    // task and the dialog are stable for the life of this screen.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageState, startIn]);

  /**
   * Above the `if (!task)` return below, and it has to stay there.
   *
   * React counts hooks per render. Sitting after that return, this one ran
   * only while a task existed — so the moment a job left myJobs, the next
   * render produced fewer hooks than the last and React threw. Abandoning
   * a job is exactly that transition, which is what surfaced it.
   *
   * The guard moved into the body instead: the hook always runs, and does
   * nothing until there is something to watch.
   */
  useEffect(() => {
    if (pageState !== 'pending_asker' || !hasApi) return;

    let stopped = false;
    const check = async () => {
      const result = await takenJobs();
      if (!result.ok || stopped) return;
      const mine = result.data.jobs.find((j) => j.id === task?.id);
      if (mine?.taskStatus === 'confirmed') setPageState('earned');
    };

    void check();
    const timer = setInterval(check, 10_000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [pageState, task?.id]);

  if (!task) {
    return (
      <View style={[styles.centered, { backgroundColor: colors.background }]}>
        <Text style={[text.title, { color: colors.foreground }]}>This job is gone.</Text>
        <Pressable onPress={() => router.back()}>
          <Text style={[text.action, { color: colors.accent }]}>Go back</Text>
        </Pressable>
      </View>
    );
  }

  const locked = Boolean(task.verifiedOnly) && identity.status !== 'verified';

  /**
   * Where the question actually pointed, when there is one.
   *
   * Jobs raised from the Ask tab carry the asker's chosen place, and that
   * place may carry coordinates. Seeded demo jobs carry neither, so the
   * distance check reports itself as skipped rather than inventing a target.
   */
  const linkedQuery = task.fromQueryId ? queries.find((q) => q.id === task.fromQueryId) : undefined;
  const targetCoords = linkedQuery?.place?.coords ?? null;
  const askedQuestion = linkedQuery?.question ?? task.title;
  const yourCut = Math.round(task.reward * (1 - PLATFORM_FEE));
  const fee = task.reward - yourCut;
  const categoryTint = {
    housing: colors.catHousing,
    fuel: colors.catFuel,
    food: colors.catFood,
    traffic: colors.catTraffic,
    shopping: colors.catShopping,
    other: colors.catOther,
    safety: colors.catSafety,
  }[task.category];

  /**
   * Shrinks a photo before it goes anywhere.
   *
   * A modern phone camera produces 4–8 MB frames, which is punishing on
   * Nigerian mobile data and slow for the asker to load. 1600px on the long
   * edge is still far more detail than a queue or a price board needs.
   */
  async function compress(uri: string): Promise<string> {
    try {
      const result = await manipulateAsync(uri, [{ resize: { width: 1600 } }], {
        compress: 0.6,
        format: SaveFormat.JPEG,
      });
      return result.uri;
    } catch {
      // Better to send the original than to lose the evidence entirely.
      return uri;
    }
  }

  /**
   * Camera only, never the gallery: evidence has to be taken now, at the
   * place, and a library picker would accept anything saved from anywhere.
   */
  async function capture() {
    setTipsOpen(false);
    setCameraError(null);

    if (media === 'photo' && shots.length >= MAX_PHOTOS) {
      setCameraError(`That is the limit of ${MAX_PHOTOS} photos.`);
      return;
    }

    try {
      const permission = await ImagePicker.requestCameraPermissionsAsync();
      if (!permission.granted) {
        setCameraError('Camera access was declined. Allow it to send evidence.');
        return;
      }

      const result = await ImagePicker.launchCameraAsync({
        mediaTypes: media === 'video' ? ['videos'] : ['images'],
        // Photos only — the picker ignores this for video, which is how a
        // 30-second clip was arriving at 11MB while photos came in at 389KB.
        quality: 0.7,
        /**
         * 720p rather than whatever the phone can manage.
         *
         * The default is High, so an iPhone recorded 1080p and the verifier
         * uploaded it from wherever they were standing. Nigerian mobile data
         * is charged by the megabyte and the upload happens in the street, so
         * the cost of the default lands on the person least able to avoid it
         * — and then again on the asker who downloads it.
         *
         * 720p is far more than enough to see whether a road is flooded or a
         * shop is open, and the gate measures sharpness on a 640px copy, so
         * nothing downstream can tell the difference.
         *
         * iOS only. Android takes whatever its camera app produces, and
         * needs a server-side transcode to match — see the note in
         * routes/evidence.ts.
         */
        videoQuality: ImagePicker.UIImagePickerControllerQualityType.IFrame1280x720,
        videoMaxDuration: MAX_VIDEO_SECONDS,
      });

      if (result.canceled || !result.assets?.length) return;
      const asset = result.assets[0];

      if (media === 'video') {
        const seconds = asset.duration ? Math.round(asset.duration / 1000) : 0;
        // videoMaxDuration caps the recorder, but not every platform honours
        // it, so the result is checked rather than trusted.
        if (seconds > MAX_VIDEO_SECONDS) {
          setCameraError(
            `That clip is ${seconds}s. Keep it under ${MAX_VIDEO_SECONDS}s and record again.`,
          );
          return;
        }
        setShots([{ uri: asset.uri, seconds }]);
        tap(Haptics.ImpactFeedbackStyle.Light);
        return;
      }

      setBusy(true);
      const uri = await compress(asset.uri);
      setShots((prev) => [...prev, { uri }].slice(0, MAX_PHOTOS));
      tap(Haptics.ImpactFeedbackStyle.Light);
    } catch {
      setCameraError('The camera could not be opened on this device.');
    } finally {
      setBusy(false);
    }
  }

  /**
   * Where the phone is, at the moment the evidence is being sent.
   *
   * `coords` was only ever filled by handleAccept, so it lived exactly as long
   * as the session that took the job. Come back to a job accepted yesterday —
   * or after the app was killed — and the gate was handed nothing, which is
   * how somebody who had shared their location was told they had not.
   *
   * Capture is also the honest moment to read it. The question the distance
   * check asks is whether you were at the place when you took this, and
   * accept-time coordinates cannot answer that: they say where you stood when
   * you agreed to go.
   *
   * Never prompts. Permission was already settled at accept, and a dialog
   * appearing on top of finished evidence would be asking for a decision at
   * the worst possible moment. Without it the check simply skips, as before.
   */
  async function whereAmINow(): Promise<{ lat: number; lng: number } | null> {
    // Does not prompt: this runs while somebody is mid-submission, and a
    // permission dialog there would interrupt the thing it is supporting.
    const found = await whereAmI(false);
    if (!found.ok) {
      // A fix that will not arrive must not cost somebody their submission.
      return coords;
    }
    setCoords(found.at);
    return found.at;
  }

  /**
   * Puts the evidence through the gate before the asker ever sees it.
   *
   * What runs depends on what is reachable. Length, photo count and distance
   * from the place are measured on the phone. Blur, lighting and whether the
   * picture plausibly matches the question need the pixels, which React Native
   * cannot read, so those happen on the API — and are honestly reported as not
   * done when no API is configured.
   *
   * A `fail` sends the verifier back to retake. A `warn` is shown and can be
   * overridden, because the cost of wrongly blocking someone who really did
   * walk to the place is far higher than the cost of a soft photo getting
   * through to an asker who can query it.
   */
  async function submitEvidence() {
    if (shots.length === 0) return;
    tap();
    setPageState('ai_checking');

    const next = attempt + 1;
    setAttempt(next);

    const at = await whereAmINow();

    const result = await runEvidenceGate({
      kind: media === 'video' ? 'video' : 'photo',
      files: shots,
      question: askedQuestion,
      placeName: task!.location,
      captured: at,
      target: targetCoords,
      /**
       * Without this the endpoint checks the file and keeps nothing.
       *
       * Storing is what the task id switches on — it is the row the evidence
       * is filed against. Omitting it meant a verifier walked somewhere, took
       * a photo, passed the checks, and the asker was shown "No image sent".
       */
      taskId: task!.taskId,
    });

    /**
     * Loud when the evidence had nowhere to go.
     *
     * Without a task id the endpoint checks the file and keeps nothing, and
     * the failure is otherwise invisible — the verifier sees a passing gate
     * and the asker later sees "No image sent". Better to know here.
     */
    if (!task!.taskId) {
      console.warn('[deliver] no taskId on this job — the evidence was checked but not stored');
    }

    setReport(result);

    if (result.verdict === 'pass') {
      await deliver(at);
      return;
    }
    setPageState('check_result');
  }

  /**
   * Hands the answer over: to the server, then to the contract.
   *
   * Server first. The answer and the evidence are what the asker actually
   * reads, and they must survive even if the chain call fails — an on-chain
   * claim against an answer nobody can see helps no one.
   *
   * The claim is what records the payee before any dispute can exist. Without
   * it, resolution would need something to supply the verifier's address, and
   * whatever supplied it could name an address of its own choosing.
   */
  async function deliver(at: { lat: number; lng: number } | null = coords) {
    /**
     * No task id, no submission.
     *
     * The evidence endpoint files what it is given against a task, and with no
     * task id it checks the file and keeps nothing. This used to warn to a
     * console and carry on, which produced the worst outcome available: the
     * asker was told an answer had arrived and shown no media, the verifier
     * was told they had been paid, and because the on-chain claim never
     * recorded them the escrow had nobody to pay and could not be released at
     * all. A trip was made, the money froze, and nothing anywhere said so.
     *
     * Refusing is not a fix for whatever loses the task id. It is a refusal to
     * turn that into an unpayable job and a lost walk.
     */
    if (!task!.taskId) {
      setDeliverError(
        'This job did not finish loading, so there is nowhere to file your evidence. ' +
          'Go back, open the job again, and send it. Nothing has been lost.',
      );
      setPageState('check_result');
      return;
    }

    setPageState('ai_checking');
    setDeliverError(null);

    const written = Object.values(answers).find((v) => v.trim().length > 0) ?? '';

    const submitted = await submitAnswer(task!.id, {
      answer: written || 'Evidence attached.',
      evidenceKind: media === 'video' ? 'video' : 'photo',
      lat: at?.lat ?? null,
      lng: at?.lng ?? null,
      distanceMetres: at && targetCoords ? Math.round(distanceMetres(at, targetCoords)) : null,
    });

    if (!submitted.ok) {
      setDeliverError(`Your answer did not send — ${submitted.detail}`);
      setPageState('check_result');
      return;
    }

    // On-chain only when the job was funded there. A ledger-only job is
    // complete at this point and must not be held up waiting for a signature.
    if (await escrowAvailable()) {
      const claimed = await claimJob(task!.id, shots[0]?.uri ?? task!.id, signAuthorization);
      if (!claimed.ok && claimed.code !== 'not_funded') {
        // Not fatal: the answer is delivered and the asker can see it. Say so
        // rather than implying the work was lost.
        /*
         * Named for what it costs, not for what failed. Until the claim
         * records a verifier, the contract has nobody to pay: the asker
         * accepting will not release the money, because release pays the
         * address the claim wrote down and there is not one yet.
         */
        setDeliverError(
          claimed.code === 'declined'
            ? 'Your answer was sent, but you did not sign, so the contract does not yet ' +
              'know to pay you. Open this job again and sign before the deadline.'
            : 'Your answer was sent, but the contract was not told you are the one to pay ' +
              `— ${claimed.detail}. Open this job again before the deadline to fix it.`,
        );
      }
    }

    setPageState('pending_asker');
  }

  /**
   * Sends the evidence past a gate that failed it.
   *
   * The tier-1 checks are arithmetic — blur, exposure, distance from the pin —
   * and arithmetic is wrong about real places often enough to matter. A flooded
   * street at dusk reads as underexposed. A mall's pin sits a hundred metres
   * from the door somebody photographed. The person standing there knows things
   * the numbers do not, and until now the numbers won and the trip was wasted.
   *
   * So the gate stops being a wall. What makes that safe is not the dialog but
   * the record: the attempt and every check it failed were already written
   * server-side when the gate ran, and submitting marks that attempt as
   * overridden — a reviewer sees exactly what was ignored, and by whom.
   */
  async function overrideGate(hardFail: boolean) {
    tap(Haptics.ImpactFeedbackStyle.Medium);

    /**
     * Asked only on a failure. A warning already says in its own words that
     * nothing is stopping you, and putting a ban notice in front of that would
     * read as an accusation for taking the app at its word.
     */
    if (hardFail) {
      const go = await confirm({
        title: 'Send it past the check?',
        message:
          'You are saying the check is wrong and that this is really what you saw. That is recorded against this job, and a reviewer can open it.\n\nSending evidence that is wrong, or that you did not take yourself, gets the account banned and any money on it held.',
        confirmLabel: 'Send it anyway',
        cancelLabel: 'Take it again',
        tone: 'danger',
      });
      if (!go) return;
    }

    await deliver();
  }

  /** Sends the verifier back to the capture form to try again. */
  function retake() {
    tap();
    setShots([]);
    setReport(null);
    setCameraError(null);
    setPageState('form');
  }

  async function handleAccept() {
    // Restricted jobs are refused here as well as hidden in the UI, so the
    // rule holds even if something routes past the disabled button.
    if (task!.verifiedOnly && identity.status !== 'verified') return;

    tap(Haptics.ImpactFeedbackStyle.Heavy);

    /**
     * Find out where we are *before* claiming the job.
     *
     * This ran the other way round — accept, then locate — which cannot work
     * now that being there is the condition of taking it. It also meant a
     * refusal arrived after the screen had already moved on, so the job looked
     * taken for a moment and then quietly was not.
     */
    setPageState('locating');

    let at: { lat: number; lng: number } | null = null;
    /**
     * Held locally as well as in state, because a refusal has to name it in
     * the same tick. `setPlace` will not have landed by the time the server
     * answers, so reading the state here would show the previous value.
     */
    let whereIAm: string | null = null;

    /**
     * Why the location is missing, not merely that it is.
     *
     * 'refused' means the prompt will never appear again and Settings is the
     * only way forward; 'unavailable' means moving or waiting will fix it.
     * Telling somebody to turn on a permission they cannot turn on from here
     * is worse than saying nothing.
     */
    let why: 'refused' | 'unavailable' | null = null;
    let whyDetail: string | null = null;

    {
      const found = await whereAmI(true);
      if (!found.ok) {
        why = found.why;
        whyDetail = found.detail ?? null;
      }
      if (found.ok) {
        at = found.at;
        setCoords(at);
        try {
          /*
           * Not on web. expo-location's reverse geocoding needs a Google Maps
           * key there and has no timeout of its own, so the best case is a
           * throw we catch and the worst is another wait with no end — on the
           * screen that had just stopped hanging. The coordinates below are a
           * complete answer; the name is a courtesy.
           */
          if (Platform.OS === 'web') throw new Error('no reverse geocoding on web');

          const [geo] = await Location.reverseGeocodeAsync({
            latitude: at.lat,
            longitude: at.lng,
          });
          // District, then city, then the coordinates themselves — something
          // recognisable if we have it, and something checkable if not.
          whereIAm =
            [geo?.district, geo?.city, geo?.region].filter(Boolean).join(', ') ||
            `${at.lat.toFixed(4)}, ${at.lng.toFixed(4)}`;
        } catch {
          whereIAm = `${at.lat.toFixed(4)}, ${at.lng.toFixed(4)}`;
        }
        setPlace(whereIAm);
      } else {
        setPlace('Location not shared');
      }
    }

    /**
     * Back to the job detail, not the evidence form.
     *
     * 'form' is the capture screen. Sending a refused verifier there put them
     * in front of a camera for a job they had just been told they could not
     * take — and any evidence they then sent would have had no task to attach
     * to. 'detail' is the page they pressed the button on.
     */
    if (!at) {
      setPageState('detail');

      if (why === 'refused') {
        /**
         * Offer the only door still open.
         *
         * Once iOS has been told no, nothing in the app can ask again — so
         * "turn location on and try again" is advice that cannot be followed.
         * Somebody taps the button, nothing happens, and there is nothing on
         * screen to say why.
         */
        const go = await confirm({
          title: 'Location is off for Confam',
          message:
            'Taking a job means proving you are at the place, so we need your location. It is switched off for this app, and only Settings can switch it back on.',
          confirmLabel: 'Open Settings',
          cancelLabel: 'Not now',
        });
        if (go) void Linking.openSettings();
        return;
      }

      /*
       * The browser refusing, rather than the sky. Over plain http on a LAN
       * address the location call never produces a fix however long anybody
       * waits, so telling them to step outside sends them to do something
       * that cannot possibly help.
       */
      if (insecurePage()) {
        await notify({
          title: 'Location needs a secure page',
          message:
            'This copy of the app is being served over an insecure address, and browsers will not share location with one. Open it over https and try again.',
        });
        return;
      }

      // Permission held but no fix arrived — indoors, airplane mode, a cold
      // GPS. A different problem, and a different thing to do about it.
      await notify({
        title: 'Could not find you',
        message:
          'We check you are at the place before you take a job, and your location did not come through. Step outside or wait a moment, then try again.' +
          /*
           * The reason, where there is one. Four identical words for a denied
           * permission, a device with no fix and fifteen seconds of silence is
           * three different problems wearing the same face, and nobody can act
           * on it — including whoever is asked to fix it afterwards.
           */
          (whyDetail ? `

(${whyDetail})` : ''),
      });
      return;
    }

    // whereIAm is what the phone calls this spot; the server needs it to
    // judge places that are areas rather than points.
    const taken = await acceptTask(task!.id, { ...at, where: whereIAm });
    if (!taken.ok) {
      // The job may well still be theirs to take — from somewhere else.
      setPageState('detail');
      await notify({
        /**
         * Say where they are, not only how far off they are.
         *
         * "You are about 254.3km away" is true and unhelpful on its own — it
         * gives no way to tell a genuine refusal from a bad GPS fix. Naming
         * the place the phone thinks it is in makes the difference obvious.
         */
        title: 'Cannot take this one',
        message: [
          taken.detail ?? 'Try again in a moment.',
          whereIAm ? `Your phone puts you in ${whereIAm}.` : null,
        ]
          .filter(Boolean)
          .join('\n\n'),
      });
      // Back to the board they were browsing, rather than leaving them on a
      // job they have just been told is not theirs to take.
      router.replace('/(tabs)/earn');
      return;
    }

    setPageState('countdown');
  }

  // ── Earned ────────────────────────────────────────────────────────────────
  if (pageState === 'earned') {
    return (
      <View style={[styles.centered, { backgroundColor: colors.background }]}>
        <Breath>
          <View style={[styles.stamp, { backgroundColor: colors.primary }]}>
            <Ionicons name="checkmark" size={44} color={colors.primaryForeground} />
          </View>
        </Breath>
        <Text style={[text.title, { color: colors.mutedForeground, marginTop: 26 }]}>
          Done. You earned
        </Text>
        <Text style={[text.amountLarge, { color: colors.foreground, fontSize: 52 }]}>
          ₦{yourCut}
        </Text>
        <Text
          style={[text.bodySmall, { color: colors.mutedForeground, textAlign: 'center', maxWidth: 280 }]}
        >
          {/* Says what happened, without asserting the on-chain transfer has
              confirmed. The asker's release is what pays; whether that
              transaction has settled is a separate question, and the wallet
              answers it. */}
          The asker confirmed your answer. The {FEE_PERCENT} platform fee has been taken off, and
          the rest is on its way to your wallet.
        </Text>
        <Pressable
          onPress={() => router.replace('/(tabs)/you')}
          style={({ pressed }) => [
            styles.wideBtn,
            {
              borderWidth: 2,
              borderColor: colors.border,
              opacity: pressed ? 0.8 : 1,
              marginTop: 30,
            },
          ]}
        >
          <Text style={[text.action, { color: colors.foreground }]}>Check my wallet</Text>
        </Pressable>

        <Pressable
          onPress={() => router.replace('/(tabs)/earn')}
          style={({ pressed }) => [
            styles.wideBtn,
            { backgroundColor: colors.foreground, opacity: pressed ? 0.88 : 1, marginTop: 10 },
          ]}
        >
          <Text style={[text.action, { color: colors.background }]}>Find another job</Text>
        </Pressable>
      </View>
    );
  }

  // ── Running the checks ────────────────────────────────────────────────────
  if (pageState === 'ai_checking') {
    return (
      <View style={[styles.centered, { backgroundColor: colors.background }]}>
        <Breath>
          <View style={[styles.glyph, { borderColor: colors.borderStrong }]}>
            <Ionicons name="scan-outline" size={34} color={colors.foreground} />
          </View>
        </Breath>
        <Text style={[text.title, { color: colors.foreground, marginTop: 24, textAlign: 'center' }]}>
          Checking your {media ?? 'evidence'}
        </Text>
        <Text
          style={[
            text.body,
            { color: colors.mutedForeground, textAlign: 'center', maxWidth: 300 },
          ]}
        >
          {hasApi
            ? 'Looking at how clear it is, how far you were from the place, and whether it matches the question.'
            : 'Checking the length and how far you were from the place.'}
        </Text>
        <ActivityIndicator color={colors.mutedForeground} style={{ marginTop: 18 }} />
      </View>
    );
  }

  // ── What the checks found ─────────────────────────────────────────────────
  if (pageState === 'check_result' && report) {
    const failed = report.verdict === 'fail';
    const attemptsLeft = Math.max(0, MAX_ATTEMPTS - attempt);
    const outOfTries = failed && attemptsLeft === 0;

    /**
     * Checks that did not run are not shown.
     *
     * A skipped check has found nothing, but it was formatted exactly like one
     * that had — same row, same list — so a submission with two real remarks
     * and three no-ops read as five problems, and the two that mattered were
     * buried among them.
     *
     * Unless everything skipped. Then the box would be empty under a heading
     * announcing a verdict, and the rows are the only honest answer to what
     * was actually looked at.
     */
    const ran = report.checks.filter((c) => c.verdict !== 'skipped');
    const shownChecks = ran.length > 0 ? ran : report.checks;

    /**
     * The way past the gate.
     *
     * Offered on a failure now, not only on a warning — and on the last
     * attempt too, which is exactly where a wrong check costs the most: the
     * alternative there is losing a trip that was really made to a blur score.
     *
     * Emphasis follows the verdict. On a warning this is the primary action,
     * because nothing is actually wrong. On a failure it sits under the retake
     * in danger colours, because the checks are usually right and whoever
     * presses it is putting their own account behind the claim.
     */
    const sendAnyway = (
      <>
        <Pressable
          onPress={() => void overrideGate(failed)}
          style={({ pressed }) => [
            styles.wideBtn,
            {
              backgroundColor: failed ? colors.surface : colors.primary,
              borderWidth: failed ? 2 : 0,
              borderColor: colors.danger,
              opacity: pressed ? 0.88 : 1,
              marginTop: 10,
            },
          ]}
        >
          <Text
            style={[text.action, { color: failed ? colors.danger : colors.primaryForeground }]}
          >
            {failed ? 'Send it anyway' : `Send it anyway · claim ₦${yourCut}`}
          </Text>
        </Pressable>

        {failed && (
          <Text
            style={[
              text.data,
              { color: colors.faintForeground, marginTop: 10, textAlign: 'center' },
            ]}
          >
            Wrong evidence, or evidence you did not take, bans the account after review.
          </Text>
        )}
      </>
    );

    return (
      <View style={[styles.screen, { backgroundColor: colors.background }]}>
        <ScrollView
          showsVerticalScrollIndicator={false}
          contentContainerStyle={[styles.scroll, { paddingTop: topPad }]}
        >
          <Text
            style={[text.label, { color: failed ? colors.danger : colors.pending, marginTop: 18 }]}
          >
            {failed ? 'Not sent' : 'Have a look first'}
          </Text>
          <Text style={[text.display, { color: colors.foreground, marginTop: 6 }]}>
            {failed ? 'Take it again.' : 'This might be a problem.'}
          </Text>
          <Text style={[text.body, { color: colors.mutedForeground, marginTop: 10 }]}>
            {failed
              ? 'Nothing was sent to the asker and the job is still yours. The clock is still running, so go again now.'
              : 'None of this stops you sending it. You were there and you know what you saw — if it is right, send it.'}
          </Text>

          <View style={[styles.checkList, { borderColor: colors.border }]}>
            {shownChecks.map((check) => (
              <CheckRow key={check.name} check={check} colors={colors} />
            ))}
          </View>

          {failed && !outOfTries && (
            <Text style={[text.data, { color: colors.faintForeground, marginTop: 12 }]}>
              {attemptsLeft === 1
                ? 'One more attempt on this job.'
                : `${attemptsLeft} more attempts on this job.`}
            </Text>
          )}

          {outOfTries ? (
            <>
              {/* Retrying forever would let a job be held while the asker's
                  deadline runs down, so the job goes back to the pool. */}
              <Text style={[text.body, { color: colors.mutedForeground, marginTop: 16 }]}>
                That is the last attempt on this one. The job can go back so somebody else can
                try — nothing is charged to you, and it does not count against your record. If you
                are sure the check is wrong, you can still send what you have.
              </Text>
              <Pressable
                onPress={() => router.replace('/(tabs)/earn')}
                style={({ pressed }) => [
                  styles.wideBtn,
                  { backgroundColor: colors.primary, opacity: pressed ? 0.88 : 1, marginTop: 22 },
                ]}
              >
                <Text style={[text.action, { color: colors.primaryForeground }]}>
                  Find another job
                </Text>
              </Pressable>
              {sendAnyway}
            </>
          ) : (
            <>
              <Pressable
                onPress={retake}
                style={({ pressed }) => [
                  styles.wideBtn,
                  {
                    backgroundColor: failed ? colors.primary : colors.surface,
                    borderWidth: failed ? 0 : 2,
                    borderColor: colors.borderStrong,
                    opacity: pressed ? 0.88 : 1,
                    marginTop: 22,
                  },
                ]}
              >
                <Text
                  style={[
                    text.action,
                    { color: failed ? colors.primaryForeground : colors.foreground },
                  ]}
                >
                  {media === 'video' ? 'Record it again' : 'Take it again'}
                </Text>
              </Pressable>

              {sendAnyway}

              {/*
                * An exit that is not another attempt.
                *
                * Both actions on this page used to lead back into it: retaking
                * returns here, and sending again runs the same submit that
                * just failed. Somebody whose submission was refused for a
                * reason retaking cannot change — no task id, an answer already
                * in — had no way off the screen but to kill the app.
                */}
              {deliverError && (
                <Pressable
                  onPress={() => {
                    tap();
                    router.replace('/(tabs)/earn');
                  }}
                  style={({ pressed }) => [
                    styles.wideBtn,
                    {
                      backgroundColor: colors.surface,
                      borderWidth: 2,
                      borderColor: colors.borderStrong,
                      opacity: pressed ? 0.88 : 1,
                      marginTop: 10,
                    },
                  ]}
                >
                  <Text style={[text.action, { color: colors.foreground }]}>
                    Leave this for now
                  </Text>
                </Pressable>
              )}
            </>
          )}
        </ScrollView>
      </View>
    );
  }

  // ── Waiting on asker ──────────────────────────────────────────────────────
  if (pageState === 'pending_asker') {
    return (
      <View style={[styles.screen, { backgroundColor: colors.background }]}>
        <ScrollView
          showsVerticalScrollIndicator={false}
          contentContainerStyle={[styles.scroll, { paddingTop: topPad }]}
        >
          <View style={styles.bar}>
            <Pressable
              onPress={() => router.back()}
              style={[styles.backBtn, { borderColor: colors.border }]}
            >
              <Ionicons name="arrow-back" size={18} color={colors.foreground} />
            </Pressable>
          </View>

          <Text style={[text.label, { color: colors.pending, marginTop: 18 }]}>Submitted</Text>
          <Text style={[text.display, { color: colors.foreground, marginTop: 6 }]}>
            Now we wait for the asker.
          </Text>
          {/* Only claims a clean check when there actually was one. A report
              with warnings the verifier overrode, or with checks that never
              ran, must not be described as having passed. */}
          <Text style={[text.body, { color: colors.mutedForeground, marginTop: 10 }]}>
            {report?.verdict === 'pass'
              ? `Your ${media ?? 'evidence'} passed every check and has been sent. You get paid the moment they confirm it — usually within minutes.`
              : `Your ${media ?? 'evidence'} has been sent. You get paid the moment they confirm it — usually within minutes.`}
          </Text>

          {report && report.verdict !== 'pass' && (
            <View style={[styles.checkList, { borderColor: colors.border }]}>
              {report.checks
                .filter((c) => c.verdict !== 'pass')
                .map((check) => (
                  <CheckRow key={check.name} check={check} colors={colors} />
                ))}
            </View>
          )}

          <View style={[styles.ledger, { borderColor: colors.border }]}>
            {[
              { k: 'Job pays', v: `₦${task.reward}`, tone: colors.foreground },
              { k: `Platform fee (${FEE_PERCENT})`, v: `−₦${fee}`, tone: colors.mutedForeground },
            ].map((r) => (
              <View key={r.k} style={[styles.ledgerRow, { borderBottomColor: colors.border }]}>
                <Text style={[text.body, { color: colors.mutedForeground, flex: 1 }]}>{r.k}</Text>
                <Text style={[text.dataMedium, { fontSize: 14, color: r.tone }]}>{r.v}</Text>
              </View>
            ))}
            <View style={[styles.ledgerRow, { borderBottomWidth: 0 }]}>
              <Text style={[text.heading, { color: colors.foreground, flex: 1 }]}>You get</Text>
              <Text style={[text.amount, { color: colors.money }]}>₦{yourCut}</Text>
            </View>
          </View>

          <Text style={[text.bodySmall, { color: colors.faintForeground, marginTop: 16 }]}>
            If the asker queries your answer, support reviews both sides before anything is
            reversed.
          </Text>

          {/* Acknowledges the message, nothing more.
              This used to credit the verifier's ledger and jump to "you
              earned ₦450 · paid out on Base" — while the asker had not even
              seen the answer. Payment happens when they confirm, and this
              screen finds out by asking the server. */}
          <Pressable
            onPress={() => router.back()}
            style={({ pressed }) => [
              styles.wideBtn,
              { backgroundColor: colors.foreground, opacity: pressed ? 0.88 : 1, marginTop: 26 },
            ]}
          >
            <Text style={[text.action, { color: colors.background }]}>Got it</Text>
          </Pressable>
        </ScrollView>
      </View>
    );
  }

  // ── Queried ───────────────────────────────────────────────────────────────
  if (pageState === 'queried') {
    return (
      <View style={[styles.screen, { backgroundColor: colors.background }]}>
        <ScrollView
          showsVerticalScrollIndicator={false}
          contentContainerStyle={[styles.scroll, { paddingTop: topPad }]}
        >
          <View style={styles.bar}>
            <Pressable
              onPress={() => router.back()}
              style={[styles.backBtn, { borderColor: colors.border }]}
            >
              <Ionicons name="arrow-back" size={18} color={colors.foreground} />
            </Pressable>
          </View>

          <Text style={[text.label, { color: colors.pending, marginTop: 18 }]}>Queried</Text>
          <Text style={[text.display, { color: colors.foreground, marginTop: 6 }]}>
            The asker disagreed.
          </Text>
          <Text style={[text.body, { color: colors.mutedForeground, marginTop: 10 }]}>
            {task?.title ?? 'This job'} is with a reviewer now. Your evidence has already been
            sent to them — you do not need to go back or take anything again.
          </Text>

          {/* Said plainly, because the alternative reading is that the work
              was thrown away. It has not been; it is being looked at. */}
          <View style={[styles.pendingNote, { borderColor: colors.pending }]}>
            <Ionicons name="hourglass-outline" size={15} color={colors.pending} />
            <Text style={[text.bodySmall, { color: colors.pending, flex: 1 }]}>
              The money stays held until a reviewer decides. If they side with you, it is paid
              out as normal.
            </Text>
          </View>
        </ScrollView>
      </View>
    );
  }


  // ── Locating ──────────────────────────────────────────────────────────────
  if (pageState === 'locating') {
    return (
      <View style={[styles.centered, { backgroundColor: colors.background }]}>
        <Breath>
          <View style={[styles.glyph, { borderColor: colors.borderStrong }]}>
            <Ionicons name="navigate-outline" size={32} color={colors.foreground} />
          </View>
        </Breath>
        <Text style={[text.title, { color: colors.foreground, marginTop: 24, textAlign: 'center' }]}>
          Finding where you are
        </Text>
        <Text
          style={[text.body, { color: colors.mutedForeground, textAlign: 'center', maxWidth: 290 }]}
        >
          So the asker can see someone is genuinely on the way.
        </Text>
      </View>
    );
  }

  // ── Countdown ─────────────────────────────────────────────────────────────
  if (pageState === 'countdown') {
    const low = startIn <= 10;
    return (
      <View style={[styles.screen, { backgroundColor: colors.background }]}>
        <View style={[styles.countdown, { paddingTop: topPad + 24 }]}>
          <Text style={[text.label, { color: colors.primary }]}>You got it first</Text>

          <Text style={[text.display, { color: colors.foreground, textAlign: 'center' }]}>
            Start heading there
          </Text>

          <Text
            style={[
              styles.bigNumber,
              { color: low ? colors.danger : colors.foreground },
            ]}
          >
            {startIn}
          </Text>
          <Text style={[text.bodySmall, { color: colors.mutedForeground, textAlign: 'center' }]}>
            The job goes back to everyone else if you do not start in time.
          </Text>

          <View style={[styles.locBox, { borderColor: colors.border }]}>
            <Ionicons name="location" size={15} color={colors.primary} />
            <View style={{ flex: 1 }}>
              <Text style={[text.subheading, { color: colors.foreground }]}>
                {place || 'Location acquired'}
              </Text>
              {coords && (
                <Text style={[text.data, { color: colors.faintForeground }]}>
                  {coords.lat.toFixed(5)}, {coords.lng.toFixed(5)}
                </Text>
              )}
            </View>
          </View>

          <View style={[styles.jobStrip, { borderColor: colors.border }]}>
            <View style={{ flex: 1 }}>
              <Text style={[text.subheading, { color: colors.foreground }]} numberOfLines={1}>
                {task.title}
              </Text>
              <Text style={[text.data, { color: colors.faintForeground }]} numberOfLines={1}>
                {task.location}
              </Text>
            </View>
            <Text style={[text.amount, { color: colors.money }]}>₦{yourCut}</Text>
          </View>

          <Pressable
            /* Locks it in: the countdown stops mattering from here. */
            onPress={() => setPageState('form')}
            style={({ pressed }) => [
              styles.wideBtn,
              { backgroundColor: colors.primary, opacity: pressed ? 0.88 : 1 },
            ]}
          >
            <Text style={[text.action, { color: colors.primaryForeground }]}>
              I am on my way
            </Text>
          </Pressable>
        </View>
      </View>
    );
  }

  // ── Detail + form ─────────────────────────────────────────────────────────
  // Under two minutes, measured against the deadline rather than a counter.
  const urgent = msLeft < 2 * 60_000;

  return (
    <View style={[styles.screen, { backgroundColor: colors.background }]}>
      <KeyboardAwareScrollViewCompat
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={[styles.scroll, { paddingTop: topPad }]}
      >
        <View style={styles.bar}>
          <Pressable
            onPress={() => router.back()}
            style={[styles.backBtn, { borderColor: colors.border }]}
          >
            <Ionicons name="arrow-back" size={18} color={colors.foreground} />
          </Pressable>
          <View style={[styles.clockChip, { borderColor: urgent ? colors.danger : colors.border }]}>
            <Ionicons
              name="time-outline"
              size={12}
              color={urgent ? colors.danger : colors.mutedForeground}
            />
            <Text
              style={[text.dataMedium, { color: urgent ? colors.danger : colors.mutedForeground }]}
            >
              {clock(Math.floor(msLeft / 1000))}
            </Text>
          </View>
        </View>

        {pageState === 'detail' ? (
          <>
            <Text style={[text.label, { color: categoryTint, marginTop: 20 }]}>
              {task.category} · {task.distance} away · {task.estimatedTime}
            </Text>
            <Text style={[text.display, { color: colors.foreground, marginTop: 8 }]}>
              {task.title}
            </Text>
            <Text style={[text.subheading, { color: colors.mutedForeground, marginTop: 8 }]}>
              {task.location}
            </Text>
            {/* An address alone is ambiguous across Nigeria — there is an
                Airport Road in Lagos, Abuja and Benin City. */}
            {(task.area || task.state) && (
              <Text style={[text.data, { color: colors.accent, marginTop: 3 }]}>
                {[task.area, task.state].filter(Boolean).join(', ')}
              </Text>
            )}

            <Text style={[text.body, { color: colors.foreground, marginTop: 20, fontSize: 15.5 }]}>
              {task.description}
            </Text>

            <View style={[styles.payBox, { backgroundColor: colors.primarySoft, borderColor: colors.primary }]}>
              <View style={{ flex: 1 }}>
                <Text style={[text.label, { color: colors.primary }]}>You keep</Text>
                <Text style={[text.amountLarge, { color: colors.foreground, marginTop: 2 }]}>
                  ₦{yourCut}
                </Text>
              </View>
              <Text style={[text.data, { color: colors.mutedForeground, textAlign: 'right' }]}>
                ₦{task.reward} job{'\n'}−₦{fee} fee
              </Text>
            </View>

            {task.askerName && (
              <View style={[styles.watchRow, { borderColor: colors.border }]}>
                <Ionicons name="person-outline" size={14} color={colors.mutedForeground} />
                <Text style={[text.bodySmall, { color: colors.mutedForeground, flex: 1 }]}>
                  Asked by{' '}
                  <Text style={{ color: colors.foreground, fontFamily: font.sansMedium }}>
                    {task.askerName}
                  </Text>
.
                </Text>
              </View>
            )}

            <View style={[styles.watchRow, { borderColor: colors.border }]}>
              <Ionicons name="eye-outline" size={14} color={colors.pending} />
              <Text style={[text.bodySmall, { color: colors.mutedForeground, flex: 1 }]}>
                <Text style={{ fontFamily: font.monoMedium, color: colors.foreground }}>
                  {watchers}
                </Text>
                {' others are looking at this. First to accept gets it, and it locks to them.'}
              </Text>
            </View>

            {locked ? (
              <Pressable
                onPress={() => router.push('/verify-identity')}
                style={({ pressed }) => [
                  styles.lockedBox,
                  { borderColor: colors.pending, opacity: pressed ? 0.8 : 1 },
                ]}
              >
                <Ionicons name="lock-closed" size={16} color={colors.pending} />
                <View style={{ flex: 1 }}>
                  <Text style={[text.heading, { color: colors.pending }]}>
                    Verified people only
                  </Text>
                  <Text style={[text.bodySmall, { color: colors.mutedForeground }]}>
                    The asker restricted this one. Verify your NIN to take jobs like it.
                  </Text>
                </View>
                <Ionicons name="arrow-forward" size={16} color={colors.pending} />
              </Pressable>
            ) : (
              <View style={styles.btnRow}>
                <Pressable
                  onPress={() => router.back()}
                  style={({ pressed }) => [
                    styles.declineBtn,
                    { borderColor: colors.border, opacity: pressed ? 0.7 : 1 },
                  ]}
                >
                  <Text style={[text.action, { color: colors.mutedForeground }]}>Not me</Text>
                </Pressable>
                <Pressable
                  onPress={handleAccept}
                  style={({ pressed }) => [
                    styles.acceptBtn,
                    { backgroundColor: colors.primary, opacity: pressed ? 0.88 : 1 },
                  ]}
                >
                  <Text style={[text.action, { color: colors.primaryForeground }]}>
                    I will go now
                  </Text>
                </Pressable>
              </View>
            )}
          </>
        ) : (
          <>
            <Text style={[text.label, { color: colors.faintForeground, marginTop: 20 }]}>
              What did you find?
            </Text>
            <Text style={[text.display, { color: colors.foreground, marginTop: 6 }]}>
              {task.title}
            </Text>

            {place ? (
              <View style={[styles.locBox, { borderColor: colors.border, marginTop: 18 }]}>
                <Ionicons name="location" size={15} color={colors.primary} />
                <Text style={[text.bodySmall, { color: colors.mutedForeground, flex: 1 }]}>
                  Answering from{' '}
                  <Text style={{ color: colors.foreground, fontFamily: font.sansMedium }}>
                    {place}
                  </Text>
                </Text>
              </View>
            ) : null}

            {task.questions.map((q) => (
              <View key={q.id} style={styles.question}>
                <Text style={[text.heading, { color: colors.foreground, marginBottom: 10 }]}>
                  {q.label}
                </Text>
                {q.type === 'boolean' ? (
                  <View style={[styles.segmented, { borderColor: colors.borderStrong }]}>
                    {['Yes', 'No'].map((opt, i) => {
                      const on = answers[q.id] === opt;
                      return (
                        <Pressable
                          key={opt}
                          onPress={() => {
                            if (Platform.OS !== 'web') Haptics.selectionAsync();
                            setAnswers((a) => ({ ...a, [q.id]: opt }));
                          }}
                          style={[
                            styles.segment,
                            i > 0 && { borderLeftWidth: 2, borderLeftColor: colors.borderStrong },
                            on && { backgroundColor: colors.foreground },
                          ]}
                        >
                          <Text
                            style={[
                              text.action,
                              { color: on ? colors.background : colors.mutedForeground },
                            ]}
                          >
                            {opt}
                          </Text>
                        </Pressable>
                      );
                    })}
                  </View>
                ) : (
                  <TextInput
                    style={[
                      styles.field,
                      {
                        color: colors.foreground,
                        backgroundColor: colors.surface,
                        borderColor: colors.border,
                        fontFamily: q.type === 'number' ? font.monoMedium : font.sans,
                      },
                    ]}
                    placeholder={q.placeholder ?? ''}
                    placeholderTextColor={colors.faintForeground}
                    keyboardType={q.type === 'number' ? 'numeric' : 'default'}
                    value={answers[q.id] ?? ''}
                    onChangeText={(v) => setAnswers((a) => ({ ...a, [q.id]: v }))}
                  />
                )}
              </View>
            ))}

            {/* Proof */}
            <Text style={[text.heading, { color: colors.foreground, marginTop: 26 }]}>
              Show us
            </Text>
            <Text style={[text.bodySmall, { color: colors.mutedForeground, marginTop: 3 }]}>
              Video gets accepted far more often than a photo.
            </Text>

            <View style={styles.mediaRow}>
              {(['photo', 'video'] as const).map((kind) => {
                const on = media === kind;
                return (
                  <Pressable
                    key={kind}
                    onPress={() => {
                      setMedia(kind);
                      setShots([]);
                      setCameraError(null);
                      if (Platform.OS !== 'web') Haptics.selectionAsync();
                      // Tips before the camera, not after: advice about how to
                      // frame a shot is useless once the shot is taken.
                      setTipsOpen(true);
                    }}
                    style={[
                      styles.mediaOption,
                      {
                        borderColor: on ? colors.foreground : colors.border,
                        backgroundColor: on ? colors.sunken : 'transparent',
                        borderWidth: on ? 2 : 1,
                      },
                    ]}
                  >
                    <Ionicons
                      name={kind === 'video' ? 'videocam-outline' : 'camera-outline'}
                      size={20}
                      color={on ? colors.foreground : colors.mutedForeground}
                    />
                    <Text
                      style={[
                        text.subheading,
                        { color: on ? colors.foreground : colors.mutedForeground },
                      ]}
                    >
                      {kind === 'video' ? 'Video' : 'Photo'}
                    </Text>
                    {kind === 'video' && (
                      <Text style={[text.data, { color: colors.primary }]}>+15%</Text>
                    )}
                  </Pressable>
                );
              })}
            </View>

            {shots.length > 0 && (
              <View style={[styles.proofBox, { borderColor: colors.primary }]}>
                <View style={styles.proofHead}>
                  <Ionicons name="checkmark-circle" size={16} color={colors.primary} />
                  <Text style={[text.subheading, { color: colors.primary, flex: 1 }]}>
                    {media === 'video'
                      ? `Video recorded${shots[0].seconds ? ` · ${shots[0].seconds}s` : ''}`
                      : `${shots.length} of ${MAX_PHOTOS} photos`}
                  </Text>
                </View>

                {media === 'photo' ? (
                  <View style={styles.thumbRow}>
                    {shots.map((shot, i) => (
                      <View key={shot.uri} style={styles.thumbWrap}>
                        <Image source={{ uri: shot.uri }} style={styles.thumb} contentFit="cover" />
                        <Pressable
                          onPress={() => setShots((prev) => prev.filter((_, n) => n !== i))}
                          hitSlop={8}
                          accessibilityLabel={`Remove photo ${i + 1}`}
                          style={[styles.thumbX, { backgroundColor: colors.background }]}
                        >
                          <Ionicons name="close" size={12} color={colors.foreground} />
                        </Pressable>
                      </View>
                    ))}

                    {shots.length < MAX_PHOTOS && (
                      <Pressable
                        onPress={() => setTipsOpen(true)}
                        style={[styles.thumbAdd, { borderColor: colors.borderStrong }]}
                      >
                        <Ionicons name="add" size={20} color={colors.mutedForeground} />
                      </Pressable>
                    )}
                  </View>
                ) : (
                  <Pressable
                    onPress={() => setTipsOpen(true)}
                    style={({ pressed }) => [styles.retake, { opacity: pressed ? 0.7 : 1 }]}
                  >
                    <Ionicons name="refresh" size={14} color={colors.mutedForeground} />
                    <Text style={[text.data, { color: colors.mutedForeground }]}>
                      Record it again
                    </Text>
                  </Pressable>
                )}
              </View>
            )}

            {busy && (
              <View style={styles.busyRow}>
                <ActivityIndicator size="small" color={colors.mutedForeground} />
                <Text style={[text.data, { color: colors.mutedForeground }]}>
                  Shrinking the photo for upload…
                </Text>
              </View>
            )}

            {cameraError && (
              <Text style={[text.bodySmall, { color: colors.danger, marginTop: 8 }]}>
                {cameraError}
              </Text>
            )}

            {/* The job promises photo or video proof, so there is nothing to
                send without it. */}
            <Pressable
              onPress={submitEvidence}
              disabled={shots.length === 0}
              style={({ pressed }) => [
                styles.wideBtn,
                {
                  backgroundColor: shots.length ? colors.primary : colors.sunken,
                  opacity: pressed ? 0.88 : 1,
                  marginTop: 26,
                },
              ]}
            >
              <Text
                style={[
                  text.action,
                  { color: shots.length ? colors.primaryForeground : colors.faintForeground },
                ]}
              >
                {shots.length ? `Send it · claim ₦${yourCut}` : 'Add proof to send'}
              </Text>
            </Pressable>

            {/*
              * A way out that is not the deadline.
              *
              * Taking a job locks it to you, and until now the only ways to
              * let go of one you could not do were to sit on it until the
              * clock ran out or to send something worthless. Both waste the
              * asker's window; this hands it straight back to somebody who
              * can go. Offered only before any evidence exists — once you
              * have sent something, the asker owes you a decision on it.
              */}
            {shots.length === 0 && (
              <Pressable
                onPress={() => {
                  void (async () => {
                    const sure = await confirm({
                      title: 'Give this job back?',
                      message:
                        'It goes back on the board for somebody else to take, and you will not be paid for it.',
                      confirmLabel: 'Give it back',
                      cancelLabel: 'Keep it',
                      tone: 'danger',
                    });
                    if (!sure) return;

                    const given = await abandonTask(task!.id);
                    if (!given.ok) {
                      await notify({
                        title: 'Could not give it back',
                        message: given.detail ?? 'Try again in a moment.',
                      });
                      return;
                    }
                    router.replace('/(tabs)/earn');
                  })();
                }}
                style={styles.giveBack}
              >
                <Text style={[text.action, { color: colors.mutedForeground }]}>
                  Give this job back
                </Text>
              </Pressable>
            )}
          </>
        )}
      </KeyboardAwareScrollViewCompat>

      {/* ── How to capture it ──────────────────────────────────────
          Shown before the camera opens. The video rule is the important
          one: saying today's date out loud is the cheapest proof that the
          clip was not recorded last week and reused. */}
      <Modal
        visible={tipsOpen}
        transparent
        animationType="fade"
        onRequestClose={() => setTipsOpen(false)}
      >
        <Pressable
          style={[styles.tipsBackdrop, { backgroundColor: colors.overlay }]}
          onPress={() => setTipsOpen(false)}
        >
          <Pressable
            onPress={(e) => e.stopPropagation()}
            style={[
              styles.tipsSheet,
              { backgroundColor: colors.background, borderColor: colors.borderStrong },
            ]}
          >
            <Text style={[text.label, { color: colors.accent }]}>
              Before you {media === 'video' ? 'record' : 'shoot'}
            </Text>
            <Text style={[styles.tipsTitle, { color: colors.foreground }]}>
              {media === 'video' ? 'Make the video count' : 'Make the photo count'}
            </Text>

            <View style={styles.tipsList}>
              {CAPTURE_TIPS[media === 'video' ? 'video' : 'photo'].map((tip) => (
                <View key={tip.lead} style={styles.tipRow}>
                  <View
                    style={[
                      styles.tipIcon,
                      { borderColor: tip.key ? colors.accent : colors.border },
                    ]}
                  >
                    <Ionicons
                      name={tip.icon}
                      size={15}
                      color={tip.key ? colors.accent : colors.mutedForeground}
                    />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text
                      style={[
                        text.subheading,
                        { color: tip.key ? colors.accent : colors.foreground },
                      ]}
                    >
                      {tip.lead}
                    </Text>
                    <Text style={[text.data, { color: colors.mutedForeground, marginTop: 2 }]}>
                      {tip.body}
                    </Text>
                  </View>
                </View>
              ))}
            </View>

            <Pressable
              onPress={capture}
              style={({ pressed }) => [
                styles.tipsGo,
                { backgroundColor: colors.primary, opacity: pressed ? 0.88 : 1 },
              ]}
            >
              <Ionicons
                name={media === 'video' ? 'videocam' : 'camera'}
                size={16}
                color={colors.primaryForeground}
              />
              <Text style={[text.action, { color: colors.primaryForeground }]}>
                {media === 'video' ? 'Start recording' : 'Open camera'}
              </Text>
            </Pressable>

            <Pressable
              onPress={() => setTipsOpen(false)}
              style={({ pressed }) => [
                styles.tipsAlt,
                { borderColor: colors.borderStrong, opacity: pressed ? 0.7 : 1 },
              ]}
            >
              <Text style={[text.action, { color: colors.mutedForeground }]}>Cancel</Text>
            </Pressable>
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  // Row of icon + sentence, used by the queried screen to say where the money
  // is without it reading as an error.
  giveBack: { alignItems: 'center', paddingVertical: 16, marginTop: 4 },
  pendingNote: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 9,
    borderWidth: 2,
    borderRadius: 2,
    padding: 13,
    marginTop: 20,
  },
  scroll: { paddingHorizontal: 20, paddingBottom: 44 },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32, gap: 8 },

  bar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  backBtn: {
    width: 38,
    height: 38,
    borderRadius: 2,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  clockChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    borderWidth: 2,
    borderRadius: 2,
    paddingHorizontal: 11,
    paddingVertical: 6,
  },

  payBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    borderWidth: 2,
    borderRadius: 2,
    padding: 18,
    marginTop: 24,
  },
  watchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 9,
    borderWidth: 2,
    borderRadius: 2,
    paddingHorizontal: 14,
    paddingVertical: 11,
    marginTop: 12,
  },

  btnRow: { flexDirection: 'row', gap: 10, marginTop: 26 },
  lockedBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    borderWidth: 2,
    borderRadius: 2,
    padding: 14,
    marginTop: 26,
  },
  declineBtn: {
    borderWidth: 2,
    borderRadius: 2,
    paddingVertical: 15,
    paddingHorizontal: 24,
    alignItems: 'center',
  },
  acceptBtn: {
    flex: 1,
    borderRadius: 2,
    paddingVertical: 15,
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkList: { borderWidth: 2, borderRadius: 2, marginTop: 20 },
  checkRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    paddingHorizontal: 13,
    paddingVertical: 12,
    borderBottomWidth: 1,
  },
  wideBtn: {
    borderRadius: 2,
    paddingVertical: 16,
    alignItems: 'center',
    justifyContent: 'center',
    alignSelf: 'stretch',
  },

  question: { marginTop: 26 },
  segmented: { flexDirection: 'row', borderWidth: 2, borderRadius: 2, overflow: 'hidden' },
  segment: { flex: 1, alignItems: 'center', paddingVertical: 14 },
  field: {
    borderWidth: 2,
    borderRadius: 2,
    paddingHorizontal: 15,
    paddingVertical: 13,
    fontSize: 15,
  },

  mediaRow: { flexDirection: 'row', gap: 10, marginTop: 14 },
  mediaOption: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    borderRadius: 2,
    paddingVertical: 18,
  },
  proofBox: { borderWidth: 2, borderRadius: 2, padding: 12, gap: 11, marginTop: 12 },
  proofHead: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  thumbRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  thumbWrap: { width: 62, height: 62 },
  thumb: { width: 62, height: 62, borderRadius: 2 },
  thumbX: {
    position: 'absolute',
    top: -6,
    right: -6,
    width: 20,
    height: 20,
    borderRadius: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  thumbAdd: {
    width: 62,
    height: 62,
    borderWidth: 2,
    borderStyle: 'dashed',
    borderRadius: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  retake: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  busyRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 10 },

  tipsBackdrop: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 20 },
  tipsSheet: {
    width: '100%',
    maxWidth: 400,
    borderWidth: 2,
    borderRadius: 2,
    padding: 20,
  },
  tipsTitle: { fontFamily: font.sansBold, fontSize: 22, lineHeight: 27, marginTop: 2 },
  tipsList: { gap: 14, marginTop: 18 },
  tipRow: { flexDirection: 'row', gap: 11 },
  tipIcon: {
    width: 30,
    height: 30,
    borderWidth: 2,
    borderRadius: 2,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  tipsGo: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    borderRadius: 2,
    paddingVertical: 15,
    marginTop: 22,
  },
  tipsAlt: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    borderWidth: 2,
    borderRadius: 2,
    paddingVertical: 14,
    marginTop: 9,
  },

  capture: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 9,
    borderWidth: 2,
    borderRadius: 2,
    paddingVertical: 26,
    marginTop: 10,
  },

  ledger: { borderWidth: 2, borderRadius: 2, marginTop: 24 },
  ledgerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: 1,
  },

  stamp: {
    width: 96,
    height: 96,
    borderRadius: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  glyph: {
    width: 88,
    height: 88,
    borderRadius: 2,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },

  countdown: { flex: 1, alignItems: 'center', paddingHorizontal: 24, gap: 14 },
  bigNumber: { fontFamily: font.monoMedium, fontSize: 76, letterSpacing: -3, lineHeight: 84 },
  locBox: {
    alignSelf: 'stretch',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    borderWidth: 2,
    borderRadius: 2,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  jobStrip: {
    alignSelf: 'stretch',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    borderWidth: 2,
    borderRadius: 2,
    paddingHorizontal: 14,
    paddingVertical: 13,
  },
});
