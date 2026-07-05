import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import vuetify from './plugins/vuetify'
import '@mdi/font/css/materialdesignicons.css'
import './styles/global.css'

createApp(App).use(createPinia()).use(vuetify).mount('#app')
