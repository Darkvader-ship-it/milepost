import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { Buffer } from 'buffer';
import { DEMO_PROGRAMME_ID } from '../context/sorobanStore';
import { VerifierDashboard } from './VerifierDashboard';

// Issue #339 — the reviewer voting section. Voting sets award amounts, so the
// rules the UI enforces before anything is signed (a reviewer only, inside the
// request's cap, amendable until finalisation) get their own coverage here.
// The contract clients are faked through `useSoroban`; nothing touches the
// network.

const REVIEWER = `GRVW${'A'.repeat(52)}`;
const APPLICANT = 'GB6PCCOLV2NF4DP4LEU7JSWAVPKXMUKCWZGL3M3VRY6FNPW3EY4R2AAW';
const VERIFY_PROGRAMME_ID = 'CBJWECZ3EUVNAE73YIMT2KWWNRHRF7NNWVKOLQRVOHSKYRYE32XBRPW7';
const REVIEW_PROGRAMME_ID = 'CCOIACASOVO3ZQLXWWJFGZAU3Y545AGPXLBP4NYHYD77RDCBPXRVZ37C';

const mocks = vi.hoisted(() => ({
  address: null as string | null,
  announce: vi.fn(),
  connect: vi.fn(),
}));

vi.mock('../context/useWallet', () => ({
  useWallet: () => ({
    address: mocks.address,
    status: mocks.address ? 'connected' : 'disconnected',
    connect: mocks.connect,
    signTransaction: vi.fn(),
  }),
}));

vi.mock('../context/useAnnouncer', () => ({ useAnnouncer: () => mocks.announce }));

function unwrap<T>(value: T) {
  return Promise.resolve({ result: { unwrap: () => value } });
}

function sendable<T>(value: T) {
  return { signAndSend: vi.fn(async () => ({ result: { unwrap: () => value } })) };
}

function makeApplication(overrides: {
  finalized?: boolean;
  withdrawn?: boolean;
  required?: bigint;
} = {}) {
  return {
    applicant: APPLICANT,
    finalized: overrides.finalized ?? false,
    metadata_hash: Buffer.alloc(32),
    requested: overrides.required ?? 5000000000n,
    submitted_at: 0,
    votes: [] as bigint[],
    withdrawn: overrides.withdrawn ?? false,
  };
}

function makeProgramme() {
  return {
    options: { contractId: DEMO_PROGRAMME_ID },
    is_reviewer: vi.fn(async () => ({ result: true })),
    is_verifier: vi.fn(async () => ({ result: true })),
    get_phase: vi.fn(async () => ({ result: 'Review' })),
    get_application: vi.fn(() => unwrap(makeApplication())),
    review: vi.fn(() => sendable(undefined)),
  };
}

let programme = makeProgramme();
let indexed: { id: string; name: string | null; creator: string | null; createdLedger: number | null }[] = [];
let programmeAtImpl: (id: string) => unknown = () => programme;

vi.mock('../context/useSoroban', () => ({
  useSoroban: () => ({
    attest: { attest: vi.fn(() => sendable(Buffer.alloc(32, 0xab))) },
    demoProgramme: programme,
    programmeAt: (id: string) => programmeAtImpl(id),
  }),
}));

vi.mock('../lib/indexer', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/indexer')>()),
  fetchProgrammes: vi.fn(async () => indexed),
}));

function renderDashboard() {
  return render(
    <MemoryRouter>
      <VerifierDashboard />
    </MemoryRouter>,
  );
}

/** Pick the fixture applicant, then wait for its application to load. */
async function selectApplicant() {
  fireEvent.click(await screen.findByRole('button', { name: /Sunrise cooperative/ }));
  await screen.findByText('Requested');
}

function typeAmount(value: string) {
  fireEvent.change(screen.getByLabelText('Approved amount'), { target: { value } });
}

function submitVote() {
  fireEvent.click(screen.getByRole('button', { name: 'Submit review vote' }));
}

beforeEach(() => {
  programme = makeProgramme();
  indexed = [];
  programmeAtImpl = () => programme;
  mocks.address = REVIEWER;
  mocks.announce.mockClear();
  mocks.connect.mockClear();
});

describe('VerifierDashboard — reviewer voting', () => {
  it('submits a vote with the reviewer’s amount for the chosen applicant', async () => {
    renderDashboard();
    await selectApplicant();

    expect(screen.getByText('Reviewer wallet')).toBeTruthy();
    expect(screen.getByText('500.00 XLM')).toBeTruthy();

    typeAmount('250');
    submitVote();

    await waitFor(() => {
      expect(programme.review).toHaveBeenCalledTimes(1);
    });
    expect(programme.review).toHaveBeenCalledWith({
      reviewer: REVIEWER,
      applicant: APPLICANT,
      approved: 2500000000n,
    });
    expect(mocks.announce).toHaveBeenCalledWith('Review vote submitted for GB6PCC…2AAW.');
    expect(await screen.findByText('Review vote submitted')).toBeTruthy();
  });

  it('amends a vote by submitting a new amount before finalisation', async () => {
    renderDashboard();
    await selectApplicant();

    typeAmount('120');
    submitVote();
    await waitFor(() => {
      expect(programme.review).toHaveBeenCalledTimes(1);
    });

    // The contract keeps one vote per reviewer; the UI lets it be replaced.
    typeAmount('180');
    submitVote();
    await waitFor(() => {
      expect(programme.review).toHaveBeenCalledTimes(2);
    });
    expect(programme.review).toHaveBeenLastCalledWith({
      reviewer: REVIEWER,
      applicant: APPLICANT,
      approved: 1800000000n,
    });
  });

  it('refuses an amount over the request inline, without signing anything', async () => {
    renderDashboard();
    await selectApplicant();

    typeAmount('600');
    submitVote();

    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText('The approved amount cannot exceed what the applicant requested.')).toBeTruthy();
    expect(programme.review).not.toHaveBeenCalled();
  });

  it('tells a non-reviewer they cannot vote and disables submitting', async () => {
    programme.is_reviewer.mockResolvedValue({ result: false });
    renderDashboard();
    await selectApplicant();

    expect(await screen.findByText('Not a reviewer')).toBeTruthy();
    const submit = screen.getByRole('button', { name: 'Submit review vote' }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);

    fireEvent.click(submit);
    expect(programme.review).not.toHaveBeenCalled();
  });

  it('explains a wrong-phase refusal rather than showing the raw error', async () => {
    programme.review.mockRejectedValue(new Error('HostError: Error(Contract, #2)'));
    renderDashboard();
    await selectApplicant();

    typeAmount('250');
    submitVote();

    // The raw failure is translated for the person: what happened, what to do,
    // and the contract's own code, never the HostError text.
    //
    // Known defect, reported rather than fixed here: this page re-runs
    // `explain()` over the `Explained` value `useTransaction` already produced,
    // so the inline panel above the outcome degrades to the generic "Something
    // went wrong" copy. The correct explanation below still renders (from the
    // transaction outcome), and that is what the user is asserted to see.
    expect(await screen.findByText('The window for this action is not open.')).toBeTruthy();
    expect(screen.getByText('Check the programme timeline for when it opens or closed.')).toBeTruthy();
    expect(screen.getByText('Nothing was transferred · program error 2')).toBeTruthy();
    expect(screen.queryByText(/HostError/)).toBeNull();
    expect(mocks.announce).toHaveBeenCalledWith('The window for this action is not open.', 'alert');
  });

  it('does not allow voting once the application has left review', async () => {
    programme.get_application.mockResolvedValue(unwrap(makeApplication({ finalized: true })));
    renderDashboard();
    await selectApplicant();

    expect(await screen.findByText('Finalized')).toBeTruthy();
    const submit = screen.getByRole('button', { name: 'Submit review vote' }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    expect((screen.getByLabelText('Approved amount') as HTMLInputElement).disabled).toBe(true);
  });

  it('refuses a malformed applicant and remembers a valid one manually entered', async () => {
    const manual = `GB${'B'.repeat(54)}`;
    renderDashboard();
    // Select a fixture applicant first: the review form (and its inline error)
    // appears once an applicant is loaded, which is where the refusal shows.
    await selectApplicant();

    fireEvent.change(screen.getByLabelText('Applicant address'), { target: { value: 'not-an-address' } });
    fireEvent.click(screen.getByRole('button', { name: 'Load applicant' }));
    expect(await screen.findByText('Enter a valid applicant address.')).toBeTruthy();
    expect(screen.getByText('GB6PCC…2AAW')).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Applicant address'), { target: { value: manual } });
    fireEvent.click(screen.getByRole('button', { name: 'Load applicant' }));

    const known = screen.getByRole('list', { name: 'Known applicants' });
    expect(await within(known).findByText('Manual applicant')).toBeTruthy();
    expect(screen.getByText(manual)).toBeTruthy();
  });

  it('shows a failed application read through explain()', async () => {
    programme.get_application.mockRejectedValue(new Error('Failed to fetch'));
    renderDashboard();

    fireEvent.click(await screen.findByRole('button', { name: /Sunrise cooperative/ }));

    expect(await screen.findByText('Could not reach the network.')).toBeTruthy();
    expect(screen.getByText('Check your connection and try again.')).toBeTruthy();
    expect(screen.queryByText(/Failed to fetch/)).toBeNull();
  });

  it('lists the programmes where the connected wallet actually holds a role', async () => {
    indexed = [
      { id: VERIFY_PROGRAMME_ID, name: 'Community resilience grants 2026', creator: null, createdLedger: 4811204 },
      { id: REVIEW_PROGRAMME_ID, name: 'Workforce skills grants, cohort 3', creator: null, createdLedger: 4702316 },
    ];
    programmeAtImpl = (id) => ({
      options: { contractId: id },
      is_verifier: vi.fn(async () => ({ result: id === VERIFY_PROGRAMME_ID })),
      is_reviewer: vi.fn(async () => ({ result: id === REVIEW_PROGRAMME_ID })),
      get_phase: vi.fn(async () => ({ result: id === REVIEW_PROGRAMME_ID ? 'Review' : 'Open' })),
      get_application: vi.fn(() => unwrap(makeApplication())),
      review: vi.fn(() => sendable(undefined)),
    });

    renderDashboard();

    expect(await screen.findByText('Community resilience grants 2026 — Open')).toBeTruthy();
    expect(await screen.findByText('Workforce skills grants, cohort 3 — Review')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Review here' })).toBeTruthy();
  });
});
