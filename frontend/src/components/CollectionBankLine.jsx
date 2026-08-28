/**
 * Who is collecting the blood, told to the camp's host.
 *
 * Shared by the magic-link organizer dashboard and the "my camps" list because
 * the wording is a product decision, not a layout one: a host who reads
 * "we're arranging a different blood bank" on one screen and a named blood bank
 * that has already declined on the other has been told two different things.
 * One component, one sentence per state.
 *
 * ⚠ The decline REASON is never rendered here, and the organiser endpoints
 * (`GET /camps/access/:token`, `GET /camps/mine`) deliberately do not even
 * select it — migration 317's column comment reserves `bb_decline_reason` for
 * the NGO admin. The host learns immediately THAT a replacement is being
 * arranged, which is the founder's call; they never learn that the blood bank
 * called their venue unworkable.
 *
 * On a decline the blood bank's NAME is suppressed too. It is still on the row
 * (clearing it would erase who declined), but printing it would read as "this
 * is who is coming" about the one institution that has said it is not.
 */
export function CollectionBankLine({
  bbResponse,
  bloodBankName,
  requestedBloodBankName,
  className = 'text-xs',
}) {
  if (bbResponse === 'DC') {
    return (
      <p className={`${className} font-medium text-amber-700`}>
        We&apos;re arranging a different blood bank for your camp — we&apos;ll confirm shortly.
      </p>
    );
  }

  if (bloodBankName) {
    if (bbResponse === 'AC') {
      return (
        <p className={`${className} text-green-700`}>
          Collection by {bloodBankName} — confirmed.
        </p>
      );
    }
    if (bbResponse === 'PE') {
      return (
        <p className={`${className} text-slate-500`}>
          Collection by {bloodBankName} — waiting for them to confirm.
        </p>
      );
    }
    // No response recorded: the NGO partnered them without the accept/decline
    // step (an older camp, or an admin bridging by hand). Nothing to caveat.
    return <p className={`${className} text-slate-500`}>Collection by {bloodBankName}.</p>;
  }

  if (requestedBloodBankName) {
    return (
      <p className={`${className} text-slate-500`}>
        You asked for {requestedBloodBankName}. We&apos;ll confirm the collecting blood bank
        shortly.
      </p>
    );
  }

  return null;
}

export default CollectionBankLine;
