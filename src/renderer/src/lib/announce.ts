import { ref } from 'vue'

export const announcement = ref('')

/** Read `text` to screen readers through the app's single polite live region. */
export function announce(text: string): void {
  announcement.value = ''
  requestAnimationFrame(() => (announcement.value = text))
}
