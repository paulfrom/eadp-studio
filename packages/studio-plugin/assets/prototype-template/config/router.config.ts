export default [
  {
    path: '/',
    component: '@/layouts/BlankLayout',
    routes: [
      { path: '/', redirect: '/demo' },
      { path: '/demo', component: './Demo', title: '合成数据演示' },
      { path: '*', component: './404', title: '页面未找到' },
    ],
  },
];
