import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import './styles.css'
import { installHorizontalWheel } from './lib/hscroll'

installHorizontalWheel()
createApp(App).use(createPinia()).mount('#app')
