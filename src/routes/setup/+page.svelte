<script lang="ts">
import SetunMark from "$lib/components/brand/SetunMark.svelte";
import AliasStep from "$lib/components/setup/AliasStep.svelte";
import ClaimForm from "$lib/components/setup/ClaimForm.svelte";
import ClassroomStep from "$lib/components/setup/ClassroomStep.svelte";
import EducatorStep from "$lib/components/setup/EducatorStep.svelte";
import FinishStep from "$lib/components/setup/FinishStep.svelte";
import GatewayStep from "$lib/components/setup/GatewayStep.svelte";
import { setupErrorMessage } from "$lib/components/setup/labels";
import StepIndicator from "$lib/components/setup/StepIndicator.svelte";
import StudentsStep from "$lib/components/setup/StudentsStep.svelte";
import * as m from "$lib/paraglide/messages";
import type { PageProps } from "./$types";

/**
 * The first-run wizard (PRD §6.2, §17).
 *
 * A step machine with no client state: which screen shows is decided on the
 * server from what is persisted, and moving between screens is a navigation.
 * That is what makes a crash between steps free — there is nothing in this
 * component worth preserving across one.
 *
 * The claim screen is not a step. Until this browser owns the setup there is
 * nothing else to show, so it replaces the wizard rather than sitting inside it.
 */

let { data, form }: PageProps = $props();

/**
 * Failures from the plain actions.
 *
 * Read with `in` rather than by casting: `ActionData` is a union across eight
 * actions, and only some of its members carry these fields.
 */
const failure = $derived(
  form && "error" in form && typeof form.error === "string" ? form.error : null,
);
const failureRetryAt = $derived(
  form && "retryAt" in form && typeof form.retryAt === "string" ? form.retryAt : null,
);
const cards = $derived(form && "cards" in form ? (form.cards ?? []) : []);

const stepFailure = $derived(setupErrorMessage(failure));
</script>

<svelte:head>
  <title>{m.setup_title()} · {m.app_name()}</title>
  <meta name="robots" content="noindex">
</svelte:head>

<main class="mx-auto flex min-h-svh max-w-2xl flex-col gap-8 px-6 py-12">
  <header class="flex flex-col gap-2">
    <SetunMark size={28} class="text-primary" />
    <h1 class="text-lg font-semibold text-foreground">{m.setup_title()}</h1>
    <p class="text-sm text-muted-foreground">{m.setup_intro()}</p>
  </header>

  {#if !data.claimed}
    <ClaimForm
      error={failure}
      retryAt={failureRetryAt ?? data.claimRetryAt}
      heldElsewhere={data.claimHeldElsewhere}
      canRecover={data.canRecover}
    />
  {:else}
    <StepIndicator steps={data.steps} current={data.step} />

    {#if stepFailure}
      <p class="text-sm text-destructive" role="alert">{stepFailure}</p>
    {/if}

    {#if data.step === "educator"}
      <EducatorStep data={data.educatorForm} minLength={data.passwordMinLength} />
    {:else if data.step === "gateway"}
      <GatewayStep health={data.gateway} />
    {:else if data.step === "alias"}
      <AliasStep data={data.aliasForm} />
    {:else if data.step === "classroom"}
      <ClassroomStep data={data.classroomForm} alias={data.alias} />
    {:else if data.step === "students"}
      <StudentsStep
        {cards}
        classroomName={data.classroomName ?? ""}
        appOrigin={data.appOrigin}
        classroomLanguage={data.classroomLanguage}
        alreadyProvisioned={data.progress.studentCount > 0}
      />
    {:else}
      <FinishStep
        aliasName={data.alias?.name ?? null}
        classroomName={data.classroomName}
        studentCount={data.progress.studentCount}
        canFinish={data.canFinish}
      />
    {/if}
  {/if}
</main>
