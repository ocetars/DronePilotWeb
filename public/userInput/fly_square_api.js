/**
 * 使用高层 API 飞行正方形
 * 
 * 这个示例展示如何使用 drone.api 来执行高层飞行命令
 * 而不是每帧返回运动指令
 */

// 检查是否已经在执行任务
if (!window.squareMissionStarted) {
  window.squareMissionStarted = true;
  
  // 定义正方形航点
  const squarePoints = [
    { x: 0.5, z: 0.5 },
    { x: 0.5, z: -0.5 },
    { x: -0.5, z: -0.5 },
    { x: -0.5, z: 0.5 },
    { x: 0, z: 0 }  // 返回原点
  ];
  
  // 使用 async IIFE 执行任务
  (async () => {
    try {
      console.log('开始执行正方形飞行任务');
      
      // 起飞到 1 米高度
      await drone.api.takeOff(1.0);
      console.log('起飞完成');
      
      // 依次飞往每个航点
      for (let i = 0; i < squarePoints.length; i++) {
        const point = squarePoints[i];
        console.log(`飞往航点 ${i + 1}: (${point.x}, ${point.z})`);
        await drone.api.moveTo({ x: point.x, z: point.z });
      }
      
      // 降落
      await drone.api.land();
      console.log('任务完成，已降落');
      
    } catch (error) {
      console.error('任务执行失败:', error);
    } finally {
      window.squareMissionStarted = false;
    }
  })();
}

// 返回悬停状态（控制器活跃时会被忽略）
return [
  { hover: true, angle: 0, speed: 0, altitude: drone.movement.model?.position.y || 0.05 },
  frame
];
