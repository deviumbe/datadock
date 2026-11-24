import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import './fonts.css'
import './styles.css'
import { installHorizontalWheel } from './lib/hscroll'
import { vPress, vRow } from './lib/rows'
import { installTooltips } from './lib/tooltip'
import { loadIconSet } from './lib/iconSets'
import { useTheme } from './stores/theme'

installHorizontalWheel()
installTooltips()
const pinia = createPinia()
const app = createApp(App).use(pinia).directive('row', vRow).directive('press', vPress)

// Have the chosen icon set ready before first paint so icons don't swap in view.
void loadIconSet(useTheme(pinia).settings.iconSet).finally(() => app.mount('#app'))
