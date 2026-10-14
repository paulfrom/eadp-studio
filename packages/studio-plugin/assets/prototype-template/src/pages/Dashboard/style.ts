import { createStyles } from '@ead/antd-style';

const useStyles = createStyles(({ prefixCls, token }) => {
  return {
    box: {
      position: 'relative',
      [`.${prefixCls}-result`]: {
        marginTop: '10%',
        ['&-icon']: {
          fontSize: token.fontSizeXL,
          color: token.colorText,
          fontWeight: 'bold',
        },
        '&-subtitle': {
          color: token.colorText,
          fontWeight: 'bold',
        },
      },
    },
  };
});

export default useStyles;
