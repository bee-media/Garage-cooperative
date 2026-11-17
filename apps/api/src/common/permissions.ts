// Каталог прав. Роли в БД хранят массив строк из этого списка.
export const PERMISSIONS = {
  'users.view': 'Просмотр пользователей',
  'users.edit': 'Создание и редактирование пользователей',
  'users.delete': 'Удаление пользователей',
  'passwords.issue': 'Выдача паролей и разблокировка',
  'garages.view': 'Просмотр гаражей',
  'garages.edit': 'Создание и редактирование гаражей',
  'garages.delete': 'Архивация гаражей',
  'debts.view': 'Просмотр задолженностей',
  'charges.edit': 'Начисления',
  'payments.edit': 'Внесение и отмена оплат',
  'settings.finance': 'Тарифы, пени, настройки финансов',
  'meters.view': 'Просмотр показаний',
  'meters.accept': 'Приём показаний',
  'news.edit': 'Новости: создание, снятие, удаление',
  'ads.moderate': 'Модерация и управление объявлениями',
  'schedule.edit': 'Расписание и контакты',
  'map.view': 'Карта: просмотр',
  'map.edit': 'Карта: редактирование',
  'map.marks': 'Карта: пометки и опоры',
  'audit.view': 'Просмотр журнала действий',
  'roles.manage': 'Управление ролями и правами',
  'releases.manage': 'Загрузка версий приложения',
  'dashboard.view': 'Дашборд',
  'data.export': 'Экспорт данных в Excel',
  'data.import': 'Импорт данных из Excel',
} as const;

export type Permission = keyof typeof PERMISSIONS;
export const ALL_PERMISSIONS = Object.keys(PERMISSIONS) as Permission[];

export const SYSTEM_ROLES: {
  name: string;
  description: string;
  portalAccess: boolean;
  permissions: Permission[];
}[] = [
  {
    name: 'Администратор',
    description: 'Полный доступ',
    portalAccess: true,
    permissions: ALL_PERMISSIONS,
  },
  {
    name: 'Председатель',
    description: 'Руководство правления',
    portalAccess: true,
    permissions: ALL_PERMISSIONS.filter((p) => p !== 'roles.manage'),
  },
  {
    name: 'Бухгалтер',
    description: 'Начисления, оплаты, долги',
    portalAccess: true,
    permissions: [
      'users.view', 'garages.view', 'debts.view', 'charges.edit', 'payments.edit',
      'settings.finance', 'meters.view', 'meters.accept', 'dashboard.view', 'map.view', 'data.export', 'data.import',
    ],
  },
  {
    name: 'Член правления',
    description: 'Приём показаний, новости, объявления',
    portalAccess: true,
    permissions: [
      'users.view', 'garages.view', 'debts.view', 'meters.view', 'meters.accept',
      'news.edit', 'ads.moderate', 'schedule.edit', 'map.view', 'dashboard.view',
    ],
  },
  {
    name: 'Электрик',
    description: 'Карта: пометки и опоры',
    portalAccess: true,
    permissions: ['garages.view', 'meters.view', 'map.view', 'map.marks'],
  },
  {
    name: 'Житель',
    description: 'Владелец гаража (мобильное приложение / PWA)',
    portalAccess: false,
    permissions: [],
  },
];
