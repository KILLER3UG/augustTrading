/**
 * Skill deep link — the small live half of what used to be
 * `SkillCitationChips`, in both directions.
 *
 * Tapping a skill anywhere (the provenance strip, a card) has to open that
 * skill's document in the library. The library may not be mounted yet when the
 * tap lands — opening it is what mounts it — so the slug is parked here as
 * well as broadcast, and the library surface consumes it on mount.
 *
 * "Try in chat" is the same problem reversed: the Chart AI dock owns the only
 * composer, surfaces render exclusively, and the Studio's "Try in chat" closes
 * the surface it is on to reach it. An event alone therefore lands on nothing,
 * which is why a tap used to look like a dead button.
 */

let pendingSkillOpen: string | null = null;

/** Open a skill's card. Safe to call whether or not the Studio is mounted. */
export const openSkillCard = (slug: string): void => {
    pendingSkillOpen = slug;
    window.dispatchEvent(new CustomEvent('august:open-skill', { detail: { slug } }));
};

/** Take (and clear) the slug a tap set before the Studio existed. */
export const consumePendingSkillOpen = (): string | null => {
    const v = pendingSkillOpen;
    pendingSkillOpen = null;
    return v;
};

let pendingSkillTry: string | null = null;

/** Put /slug in the Chart AI composer. Safe whether or not the dock is
 *  mounted: the broadcast serves the live dock, the parked value serves the
 *  dock that mounts in response to the tap. */
export const requestSkillTry = (slug: string): void => {
    pendingSkillTry = slug;
    window.dispatchEvent(new CustomEvent('august:try-skill', { detail: { slug } }));
};

/** Take (and clear) the slug "Try in chat" parked for the next dock mount. */
export const consumePendingSkillTry = (): string | null => {
    const v = pendingSkillTry;
    pendingSkillTry = null;
    return v;
};
