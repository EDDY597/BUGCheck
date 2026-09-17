// =============================================
// BUG校验工具 - 模块层级数据
// 来源: D:\10 需求\CrobotpOS-Roadmap.xlsx → CrobotpOS测试规格 工作表
// 结构: 一级规格 → 二级规格 → 三级规格
// 最末级 = 三级规格, 或无子级的二级/一级规格
// =============================================

const moduleHierarchy = {
  "文件管理": {
    features: ["文件列表", "文件备份", "文件恢复", "软件升级", "急救包"]
  },
  "参数设置": {
    features: ["操作参数", "轴参数", "速度参数", "机构参数"],
    children: {
      "驱动参数": ["常用参数", "电机参数"],
      "控制参数": ["电机参数", "碰撞参数", "动力学", "快捷摩擦力", "减速器", "平滑", "精度", "速度限制", "滤波参数", "软浮动参数", "摆动参数"]
    },
    subFeatures: ["机械单元", "机械单元组", "协作IO设置"]
  },
  "功能设置": {
    features: ["工具", "用户", "同步轴设置", "零点", "机器人标定", "重力方向", "干涉区",
               "坐标系测量", "变量配置表", "碰撞检测预设", "视觉功能", "自定义事件",
               "附加载荷", "后台任务", "软浮动预设", "工装脱离", "自定义界面"],
    children: {
      "远程/预约": ["远程", "预约", "程序号启动", "--"],
      "通讯": ["Modbus客户端", "Modbus主站", "Modbus服务器", "Modbus从站", "TCP/IP",
               "EtherCAT主", "EtherCAT伺服从站", "EtherCAT IO从站", "EtherCAT从(Anybus)",
               "CanOpen", "ProfileNet主", "ProfileNet从(Anybus)", "CC-Link主",
               "CC-Link IE从(Anybus)", "CC-Link IE Field从(Anybus)", "EtherNetIP主",
               "EtherNetIP从(Anybus)", "EtherNetIP从", "DeviceNet主", "ProfiNetSafe主",
               "ProfiNetSafe从(Anybus)"],
      "跟踪功能": ["直线跟踪", "圆弧跟踪", "地轨跟踪"]
    }
  },
  "系统信息": {
    children: {
      "伺服总线": ["通讯状态", "各轴状态"],
      "驱动": ["编码器", "驱动状态", "模块信息"]
    },
    subFeatures: ["软件版本"]
  },
  "用户工艺": {
    features: ["工艺快捷键", "焊接微调", "曲线导出", "电弧跟踪", "寻位工艺", "激光跟踪",
               "码垛工艺", "偏移", "鱼鳞焊", "激光熔覆", "飞拍工艺", "协同", "冲压工艺",
               "折弯工艺", "机床上下料", "打磨工艺", "压铸工艺", "喷涂工艺", "螺丝锁付",
               "螺旋管", "协作机器人"],
    children: {
      "焊接工艺": ["焊机配置", "工艺参数", "摆动工艺", "多层多道", "生产计数"],
      "激光焊接": ["设备配置", "工艺参数", "摆动工艺", "生产计数"],
      "专家数据库": ["中厚板数据库", "数据库管理", "弧焊数据库"],
      "点焊工艺": ["点焊配置", "工艺参数", "焊枪配置"],
      "激光切割": ["激光配置", "激光参数", "图形参数"]
    }
  },
  "PLC": {
    features: ["PLC"]
  },
  "监视": {
    features: ["预约状态", "时间", "输入/输出", "寄存器", "位置变量"],
    children: {
      "工艺监视": ["激光监视", "点焊监视", "码垛监视", "跟踪监视", "焊接监视",
                  "焊机监视", "焊机面板", "生产计数", "微调监视", "冲压监视", "电弧跟踪监视"],
      "坐标": ["关节坐标", "世界坐标", "直角坐标", "用户坐标"],
      "速度": ["关节速度", "TCP速度"],
      "电机": ["指令位置", "反馈位置", "电机速度", "绝对位置", "超差位置", "转矩", "干扰力"]
    }
  },
  "用户管理": {
    features: ["账号管理", "登录/注销"]
  },
  "系统设置": {
    features: ["时间加密", "IP设置", "主机名称", "语言设置", "系统时间", "屏幕校准",
               "无线网络", "无线热点", "硬件配置"]
  },
  "程序": {
    features: ["机器人程序", "并行程序", "编辑菜单", "查看点位", "查看变量",
               "修改指令", "中文编程", "C型编辑界面", "E型编辑界面"],
    children: {
      "指令菜单": ["运动指令", "IO指令", "控制指令", "演算指令", "特殊指令",
                  "焊接指令", "点焊指令", "码垛指令", "视觉指令", "跟踪指令",
                  "切割指令", "其它指令", "通讯指令"]
    }
  },
  "左右侧边栏": {
    children: {
      "C型左侧边栏": ["速度倍率", "快捷回零", "坐标系切换", "M快捷键", "伺服开关", "清除报警", "信息列表"],
      "C型右侧边栏": ["回零", "轴键-GP试运行", "轴键-关节运动", "轴键-笛卡尔运动",
                      "程序运行模式", "机械单元切换", "气检开关", "送丝控制", "手动焊接", "焊接使能", "焊接复位"]
    }
  },
  "状态栏": {
    features: ["维护保养", "紧急停止", "节能模式", "协同", "机械单元", "工具", "用户",
               "工作模式", "时间", "拖动状态", "程序循环模式", "速度倍率", "坐标系", "程序状态"],
    children: {
      "控制栏": ["热拔插"]
    }
  },
  "FN": {
    features: ["驱动参数读写", "轨迹输出", "程序偏移", "轴禁止", "临时屏蔽碰撞报警",
               "碰撞权限", "零位权限", "焊点平移", "时间加密", "G10焊机参数导入"]
  },
  "总线": {
    features: ["MIII", "EtherCAT"]
  },
  "伺服": {
    features: ["焊枪软浮动", "固件升级"]
  },
  "其他": {
    features: ["外部引导", "外部急停", "限速限加速", "外部轴", "智慧云", "输入法",
               "UPS", "重力补偿", "节能模式", "关节滤波", "步长滤波", "三段叠加",
               "平滑叠加", "小距离加速", "协作手柄", "运动控制", "运动学", "动力学",
               "机器人模型", "轨迹规划", "UI问题", "系统启动", "语言包", "客户使用不当",
               "其它", "设备故障(broken)"],
    children: {
      "产品出厂配置": ["开机画面", "默认参数", "负载识别程序", "系统PLC"],
      "软键盘": ["全键盘", "小键盘"],
      "日志系统": ["示教器日志", "控制器日志", "按键日志", "事件日志"]
    }
  },
  "示教器": {
    features: ["安全开关", "钥匙开关", "急停开关", "C型滚轮", "E型按键", "屏幕",
               "正向运行", "逆向运行", "暂停运行", "速度+", "速度-"],
    children: {
      "C型按键": ["C1", "C2", "C3", "C4"],
      "状态指示灯": ["Power状态", "Alarm状态"],
      "U盘接口": ["U盘", "外设"]
    }
  },
  "BSP": {
    children: {
      "控制器": ["CrobotpBSP-aarch64-Zhiyuan", "CrobotpBSP-aarch64-Tronlong（创龙）", "CrobotpBSP-x64-Advan（研华）"],
      "示教器": ["CrobotpBSP-armv7-Zhiyuan", "CrobotpBSP-armv7-Tronlong"]
    }
  },
  "电弧跟踪": {
    features: []
  },
  "CrobotpLab": {
    features: []
  },
  "激光跟踪": {
    features: ["激光跟踪", "激光探头小板", "VLS", "VLS-SDK"]
  },
  "智能化方案": {
    features: ["油箱焊接", "中储粮快检仪", "轮毂打磨", "管板智能焊接", "船锚链",
               "铁塔脚焊接", "青藤多棱锥杆", "豪特玻璃抓取", "木工智能分拣(拆码垛)",
               "建坤免示教", "螺旋管"]
  }
};

// 获取所有最末级规格（叶子节点）
function getAllLeafModules() {
  const leaves = [];
  for (const [l1, data] of Object.entries(moduleHierarchy)) {
    if (data.children) {
      for (const [l2, l3List] of Object.entries(data.children)) {
        l3List.forEach(l3 => leaves.push(l3));
      }
      if (data.features) {
        data.features.forEach(f => {
          if (!Object.keys(data.children).includes(f)) {
            leaves.push(f);
          }
        });
      }
      if (data.subFeatures) {
        data.subFeatures.forEach(f => leaves.push(f));
      }
    } else if (data.features) {
      data.features.forEach(f => leaves.push(f));
    } else {
      leaves.push(l1);
    }
  }
  return [...new Set(leaves)];
}

function isLeafModule(name) {
  const leaves = getAllLeafModules();
  return leaves.includes(name);
}

function getLastSegment(path) {
  if (!path) return '';
  const parts = path.split('/');
  let last = parts[parts.length - 1].trim();
  // 去掉括号后缀，如"送丝控制（R4）"→"送丝控制"
  last = last.replace(/[（(][^）)]*[）)]$/, '').trim();
  return last;
}

// 用于校验详情展示：去掉括号后缀（供 isLeafModule/checkModule 自动调用）
function stripParenthetical(s) {
  if (!s) return '';
  return s.replace(/[（(][^）)]*[）)]$/, '').trim();
}

function checkModule(path) {
  if (!path) return { pass: false, detail: '❌ 模块未填写' };

  const lastSeg = getLastSegment(path);

  if (isLeafModule(lastSeg)) {
    return { pass: true, detail: `✓ 模块"${lastSeg}"是最末级规格` };
  }

  for (const [l1, data] of Object.entries(moduleHierarchy)) {
    if (lastSeg === l1) {
      const options = [];
      if (data.features) options.push(...data.features);
      if (data.children) Object.keys(data.children).forEach(k => options.push(k + '(有子级)'));
      if (data.subFeatures) options.push(...data.subFeatures);
      return { pass: false, detail: `❌ "${lastSeg}"是父级，可选: ${options.slice(0,5).join(', ')}...` };
    }
    if (data.children && Object.keys(data.children).includes(lastSeg)) {
      const subs = data.children[lastSeg];
      return { pass: false, detail: `❌ "${lastSeg}"有子级，应选: ${subs.slice(0,5).join(', ')}...` };
    }
  }

  return { pass: false, detail: `⚠️ "${lastSeg}"未在测试规格表中找到` };
}

module.exports = { moduleHierarchy, getAllLeafModules, isLeafModule, checkModule, getLastSegment, stripParenthetical };
