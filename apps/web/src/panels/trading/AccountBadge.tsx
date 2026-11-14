import type { AccountState } from '@ts/oms/types';

/** PAPER or LIVE, impossible to mistake for each other. */
export function AccountBadge({ account }: { account: Pick<AccountState, 'kind'> | null | undefined }) {
    const kind = account?.kind ?? 'paper';
    const label = kind === 'paper' ? 'PAPER' : kind === 'sandbox' ? 'SANDBOX' : 'LIVE';
    return (
        <span
            className={`acct-badge acct-${kind}`}
            data-testid="account-badge"
            title={kind === 'live' ? 'Orders from this screen use real money' : 'No real money is used'}
        >
            {label}
        </span>
    );
}
