const routes: any[] = [
  {
    path: '/',
    component: '@/layouts/AuthLayout',
    title: '开发菜单',
    name: '开发菜单',
    routes: [
      { path: '/demo', name: 'demo', title: 'demo', component: './Demo' },
      {
        path: '*',
        component: './404',
        title: '页面未找到',
        hideInMenu: true,
      },
    ],
  },
];

if (process.env.NODE_ENV !== 'production') {
  routes[0].routes = [
    { path: '/', redirect: '/dashboard' },
    { path: '/dashboard', component: './Dashboard' },
    ...routes[0].routes,
  ];
  routes.unshift({
    path: '/user',
    name: '用户登录',
    component: '@/layouts/LoginLayout',
    routes: [
      { path: '/user', redirect: '/user/login' },
      { path: '/user/login', component: './Login' },
      { path: '*', component: './404', title: '页面未找到', hideInMenu: true },
    ],
  });
}

export default routes;
