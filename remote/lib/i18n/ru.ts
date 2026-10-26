import type { Strings } from './index';

// Russian strings. Must have exactly the keys of `pl` (checked by the type and by i18n.test.ts).
export const ru: Strings = {
  'app.title': 'Kopernikadr',
  'app.subtitle': 'Пульт для покадровой камеры',
  'home.connect': 'Подключиться к камере',
  'home.connectSoon': 'Подключение к камере появится позже.',
  'home.diagnostics': 'Диагностика',
  'diag.title': 'Диагностика',
  'diag.back': 'Назад',
  'diag.run': 'Запустить тесты',
  'diag.notRun': 'не запускался',
  'diag.count': { one: '{n} тест', few: '{n} теста', many: '{n} тестов', other: '{n} теста' },
  'probe.env': 'Среда (WebView, безопасный контекст, WebCodecs)',
  'probe.nsd': 'Поиск камеры (NSD)',
  'probe.camera': 'Камера: подключение, превью, снимок',
  'probe.reconnect': 'Переподключение',
  'probe.download': 'Скачивание оригиналов',
  'probe.videoFrame': 'VideoFrame из скачанного снимка',
  'probe.export': 'Экспорт MP4 в галерею',
  'probe.storage': 'Свободное место',
};
