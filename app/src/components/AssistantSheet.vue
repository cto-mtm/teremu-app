<script setup lang="ts">
import { nextTick, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { apiFetch } from '../lib/api'
import { assistantResponseSchema } from '../lib/schemas'
import { useAuthStore } from '../stores/auth'

/**
 * Conversational assistant sheet. The transcript lives ONLY in this
 * component (session memory — gone on reload); recent turns ride along
 * with each request so follow-ups resolve, while the server stays
 * stateless and rebuilds a perm-filtered data snapshot every call.
 */
const { t } = useI18n()
const open = defineModel<boolean>({ required: true })
const auth = useAuthStore()

interface Turn {
  role: 'user' | 'assistant'
  content: string
}

const messages = ref<Turn[]>([])
const question = ref('')
const busy = ref(false)
const failed = ref(false)
const scroller = ref<HTMLElement | null>(null)

async function scrollToEnd(): Promise<void> {
  await nextTick()
  scroller.value?.scrollTo({ top: scroller.value.scrollHeight, behavior: 'smooth' })
}

watch(open, (isOpen) => {
  if (isOpen) void scrollToEnd()
})

async function ask(): Promise<void> {
  const q = question.value.trim()
  if (q.length < 3 || busy.value) return
  failed.value = false
  const history = messages.value.slice(-10)
  messages.value = [...messages.value, { role: 'user', content: q }]
  question.value = ''
  busy.value = true
  void scrollToEnd()

  const res = await apiFetch<{ answer: string }>(
    '/assistant',
    { method: 'POST', body: JSON.stringify({ question: q, history }) },
    assistantResponseSchema,
  )
  busy.value = false
  if (res.ok) {
    messages.value = [...messages.value, { role: 'assistant', content: res.data.answer }]
  } else {
    failed.value = true
  }
  void scrollToEnd()
}

function clearConversation(): void {
  messages.value = []
  failed.value = false
}
</script>

<template>
  <Transition name="list">
    <div
      v-if="open"
      class="fixed inset-0 z-40 flex items-end justify-center bg-black/30 backdrop-blur-sm sm:items-center"
      @click="open = false"
    >
      <div
        class="flex h-[80vh] w-full flex-col rounded-t-2xl bg-white/95 backdrop-blur-md sm:h-[70vh] sm:max-w-2xl sm:rounded-2xl"
        @click.stop
      >
        <!-- Header -->
        <div class="flex items-center justify-between gap-3 border-b border-gray-100 px-5 py-4">
          <div class="min-w-0">
            <h2 class="flex items-center gap-2 text-lg font-bold">
              <svg viewBox="0 0 24 24" class="sparkle h-5 w-5 shrink-0 text-ember" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M12 3l1.7 5.3L19 10l-5.3 1.7L12 17l-1.7-5.3L5 10l5.3-1.7L12 3Z" />
                <path d="M19 15l.6 1.9L21.5 17.5l-1.9.6L19 20l-.6-1.9L16.5 17.5l1.9-.6L19 15Z" />
              </svg>
              {{ t('assistant.title') }}
            </h2>
            <p class="mt-0.5 truncate text-xs text-smoke">{{ t('assistant.hint') }}</p>
          </div>
          <button
            v-if="messages.length"
            class="shrink-0 text-xs font-medium text-smoke hover:text-ink"
            @click="clearConversation"
          >
            {{ t('assistant.clear') }}
          </button>
        </div>

        <!-- Pro gate -->
        <div
          v-if="auth.profile?.plan === 'free'"
          class="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center"
        >
          <svg viewBox="0 0 24 24" class="h-9 w-9 text-ember" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M12 3l1.7 5.3L19 10l-5.3 1.7L12 17l-1.7-5.3L5 10l5.3-1.7L12 3Z" />
            <path d="M19 15l.6 1.9L21.5 17.5l-1.9.6L19 20l-.6-1.9L16.5 17.5l1.9-.6L19 15Z" />
          </svg>
          <p class="text-sm font-semibold">{{ t('assistant.proOnly') }}</p>
          <p class="text-xs text-smoke">{{ t('assistant.proHint') }}</p>
        </div>

        <!-- Transcript -->
        <div v-else ref="scroller" class="flex-1 space-y-3 overflow-y-auto px-5 py-4">
          <p v-if="messages.length === 0" class="py-10 text-center text-sm text-smoke">
            {{ t('assistant.placeholder') }}
          </p>

          <TransitionGroup name="msg">
            <div
              v-for="(msg, i) in messages"
              :key="i"
              class="flex"
              :class="msg.role === 'user' ? 'justify-end' : 'justify-start'"
            >
              <div
                class="max-w-[85%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed whitespace-pre-line"
                :class="
                  msg.role === 'user'
                    ? 'rounded-br-md bg-ember text-white'
                    : 'rounded-bl-md bg-ember-50 text-ink'
                "
              >
                {{ msg.content }}
              </div>
            </div>

            <!-- Typing indicator -->
            <div v-if="busy" key="typing" class="flex justify-start">
              <div class="flex items-center gap-1.5 rounded-2xl rounded-bl-md bg-ember-50 px-4 py-3">
                <span class="dot h-2 w-2 rounded-full bg-ember" />
                <span class="dot h-2 w-2 rounded-full bg-ember" style="animation-delay: 0.15s" />
                <span class="dot h-2 w-2 rounded-full bg-ember" style="animation-delay: 0.3s" />
              </div>
            </div>
          </TransitionGroup>

          <p v-if="failed" class="text-center text-xs text-coral-600">{{ t('assistant.error') }}</p>
        </div>

        <!-- Composer -->
        <form v-if="auth.profile?.plan !== 'free'" class="flex gap-2 border-t border-gray-100 p-4" @submit.prevent="ask">
          <input
            v-model="question"
            class="input flex-1"
            :placeholder="t('assistant.placeholder')"
            :disabled="busy"
          />
          <button class="btn-primary shrink-0" :disabled="busy || question.trim().length < 3" type="submit">
            {{ t('assistant.ask') }}
          </button>
        </form>
      </div>
    </div>
  </Transition>
</template>

<style scoped>
/* Message entrance — transform & opacity only (house rules) */
.msg-enter-active {
  transition:
    transform 260ms cubic-bezier(0.4, 0, 0.2, 1),
    opacity 260ms cubic-bezier(0.4, 0, 0.2, 1);
}
.msg-leave-active {
  transition:
    transform 180ms cubic-bezier(0.4, 0, 0.2, 1),
    opacity 180ms cubic-bezier(0.4, 0, 0.2, 1);
}
.msg-enter-from,
.msg-leave-to {
  transform: translateY(10px) scale(0.97);
  opacity: 0;
}

/* Typing dots */
@keyframes dot-bounce {
  0%,
  60%,
  100% {
    transform: translateY(0);
    opacity: 0.5;
  }
  30% {
    transform: translateY(-4px);
    opacity: 1;
  }
}
.dot {
  animation: dot-bounce 1.1s ease-in-out infinite;
}

/* Gentle sparkle pulse in the header */
@keyframes sparkle-pulse {
  0%,
  100% {
    transform: scale(1);
    opacity: 1;
  }
  50% {
    transform: scale(1.18);
    opacity: 0.85;
  }
}
.sparkle {
  animation: sparkle-pulse 2.4s ease-in-out infinite;
}

@media (prefers-reduced-motion: reduce) {
  .msg-enter-active,
  .msg-leave-active,
  .dot,
  .sparkle {
    transition: none;
    animation: none;
  }
}
</style>
