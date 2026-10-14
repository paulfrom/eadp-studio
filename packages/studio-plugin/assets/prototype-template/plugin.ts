import { IApi } from 'umi';

export default (api: IApi) => {
  api.addMiddlewares(() => [
    async (req, res, next) => {
      const historyType = api.userConfig.history.type || 'browser';
      const { base } = api.userConfig;
      if (
        historyType === 'hash' &&
        base !== '/' &&
        (req.path === '/' || req.path === '/index.html')
      ) {
        return res.redirect(`${base}#${base}`);
      }
      next();
    },
  ]);
};
