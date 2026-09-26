<script lang="ts">
import { enhance } from "$app/forms";
import AllowanceMeter from "$lib/components/classroom/AllowanceMeter.svelte";
import ConversationSearch from "$lib/components/student/ConversationSearch.svelte";
import ThemeControl from "$lib/components/ui/ThemeControl.svelte";
import * as m from "$lib/paraglide/messages";
import { getLocale } from "$lib/paraglide/runtime";
import type { PageProps } from "./$types";

/**
 * Everything the system knows about this pupil, shown to them (PRD §16, §18).
 *
 * "Deliberately thin", and deliberately complete: a label they did not choose, a
 * nickname they did, when the classroom next opens, what today's allowance has
 * cost, their conversations, their creations, and their own skills. No real
 * name appears because none was ever asked for.
 *
 * No persistent header, and nothing that needs a wide screen: usable height on
 * the target device is about 640 pixels (§20).
 */
let { data }: PageProps = $props();

const moment = $derived(new Intl.DateTimeFormat(getLocale(), { dateStyle: "long" }));

const nextOpening = $derived.by(() => {
  if (!data.status.nextOpeningAt) return null;
  return new Intl.DateTimeFormat(getLocale(), {
    weekday: "long",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone: data.status.timezone,
  }).format(new Date(data.status.nextOpeningAt));
});

const field = "h-10 rounded-md border border-input bg-background px-3 text-sm text-foreground";
const action =
  "h-10 rounded-md border border-input px-3 text-sm font-medium text-foreground hover:bg-secondary";
</script>

<svelte:head><title>{m.student_dashboard_title()} · {m.app_name()}</title></svelte:head>

<main class="mx-auto flex w-full max-w-2xl flex-col gap-8 p-4 pb-16">
  <header class="flex flex-col gap-1">
    <h1 class="text-base font-semibold text-foreground">{m.student_dashboard_title()}</h1>
    <p class="text-xs text-muted-foreground">
      {m.student_account_since({ when: moment.format(new Date(data.student.createdAt)) })}
    </p>
  </header>

  <!-- Account: the label, the nickname, and nothing that identifies anybody (§16). -->
  <section class="flex flex-col gap-3">
    <h2 class="text-sm font-medium text-foreground">{m.student_account_title()}</h2>

    <dl class="flex flex-col gap-1.5 text-sm">
      <div class="flex flex-wrap justify-between gap-2">
        <dt class="text-muted-foreground">{m.student_label_title()}</dt>
        <dd class="font-medium text-foreground">{data.student.label}</dd>
      </div>
      {#if data.classroomName}
        <div class="flex flex-wrap justify-between gap-2">
          <dt class="text-muted-foreground">{m.educator_classrooms_title()}</dt>
          <dd class="text-foreground">{data.classroomName}</dd>
        </div>
      {/if}
      <div class="flex flex-wrap justify-between gap-2">
        <dt class="text-muted-foreground">{m.student_card_title()}</dt>
        <dd class="text-foreground">
          {m.educator_card_hint({ hint: data.student.credentialHint })}
        </dd>
      </div>
    </dl>

    <form method="POST" action="?/displayName" use:enhance class="flex flex-wrap items-end gap-2">
      <label class="flex min-w-48 flex-1 flex-col gap-1">
        <span class="text-xs text-muted-foreground">{m.student_display_name_label()}</span>
        <input
          name="displayName"
          maxlength="40"
          value={data.student.displayName ?? ""}
          placeholder={m.student_display_name_placeholder()}
          class={field}
        >
      </label>
      <button type="submit" class={action}>{m.educator_save()}</button>
    </form>
    <p class="text-xs text-muted-foreground">{m.student_display_name_help()}</p>
  </section>

  <!-- Open or closed, with the next window in the classroom's own timezone (§8, §18). -->
  <section class="flex flex-col gap-2">
    <!--
      A neutral heading: the state is the paragraph below it, and this section is
      shown whether the classroom is open or closed. It used to reuse
      `classroom_closed_title`, so a pupil whose classroom was open read
      "Classroom closed" with the word "Open" directly beneath it.
      `ClassroomClosed.svelte` still uses that message, correctly — it only ever
      renders when the classroom is in fact closed.
    -->
    <h2 class="text-sm font-medium text-foreground">{m.classroom_status_title()}</h2>
    <p class="text-sm text-foreground">
      {#if data.status.open}
        {m.educator_state_open()}
      {:else if data.status.reason === "explicit-lock"}
        {m.classroom_closed_locked()}
      {:else}
        {m.classroom_closed_outside()}
      {/if}
    </p>
    {#if !data.status.open}
      <p class="text-xs text-muted-foreground">
        {#if nextOpening}
          {m.classroom_next_opening_label()}: {nextOpening}
        {:else}
          {m.classroom_no_next_opening()}
        {/if}
      </p>
    {/if}
  </section>

  <AllowanceMeter allowance={data.status.allowance} />

  <ConversationSearch conversations={data.conversations} />

  <section class="flex flex-col gap-2">
    <h2 class="text-sm font-medium text-foreground">{m.creations_title()}</h2>
    <p class="text-sm text-muted-foreground">
      {m.student_creations_count({
  artifacts: data.creations.artifacts,
  images: data.creations.images,
})}
    </p>
    <a href="/creations" class="self-start text-xs text-primary underline underline-offset-2">
      {m.student_open_creations()}
    </a>
  </section>

  <section class="flex flex-col gap-2">
    <h2 class="text-sm font-medium text-foreground">{m.student_skills_title()}</h2>
    {#if data.skills.length === 0}
      <p class="text-xs text-muted-foreground">{m.student_skills_empty()}</p>
    {:else}
      <ul class="flex flex-col divide-y divide-border border-y border-border">
        {#each data.skills as skill (skill.id)}
          <li class="flex flex-wrap items-baseline justify-between gap-2 py-2.5">
            <span class="text-sm text-foreground">{skill.name}</span>
            {#if skill.approvalState === "pending"}
              <span class="text-xs text-muted-foreground">
                {m.educator_student_skill_pending()}
              </span>
            {:else if !skill.enabled}
              <span class="text-xs text-muted-foreground">{m.educator_skill_disabled_badge()}</span>
            {/if}
          </li>
        {/each}
      </ul>
    {/if}
    <a href="/skills" class="self-start text-xs text-primary underline underline-offset-2">
      {m.student_open_skills()}
    </a>
  </section>

  <!--
    How the interface is coloured (§20).

    A device setting rather than an account one: it is stored in this browser and
    reaches neither the server nor another pupil's Chromebook, so nothing about
    how a pupil likes to read is recorded against them (§16).
  -->
  <section class="flex flex-col gap-2">
    <h2 class="text-sm font-medium text-foreground">{m.theme_label()}</h2>
    <div class="max-w-56"><ThemeControl /></div>
  </section>

  <!-- The pupil's own language, overriding the classroom's (§8, §18). -->
  <section class="flex flex-col gap-2">
    <h2 class="text-sm font-medium text-foreground">{m.student_language_label()}</h2>
    <!--
      A full document reload after saving, not the default enhance. Paraglide
      latches the resolved locale at hydration, so an in-place invalidateAll
      leaves already-rendered messages in the old language until the next
      navigation — a mixed-language flash. Reloading re-resolves the locale from
      the freshly written PARAGLIDE_LOCALE cookie for the whole tree at once.
    -->
    <form
      method="POST"
      action="?/language"
      use:enhance={() =>
  async ({ result, update }) => {
    if (result.type === "success" || result.type === "redirect") {
      window.location.reload();
      return;
    }
    await update();
  }}
      class="flex flex-wrap items-end gap-2"
    >
      <select name="language" value={data.student.interfaceLanguage ?? ""} class={field}>
        <option value="">{m.student_language_follow_class()}</option>
        <option value="da">{m.educator_language_da()}</option>
        <option value="en">{m.educator_language_en()}</option>
      </select>
      <button type="submit" class={action}>{m.student_language_save()}</button>
    </form>
  </section>
</main>
