const ical = require('node-ical');

let mockDb = {
  totalSavedAmount: 342.5,
  rooms: [
    {
      id: 'r1',
      name: 'Room 101',
      status: 'Occupied',
      isPowerOn: true,
      icalUrl: '에어비앤비_ical_링크_1',
    },
    {
      id: 'r2',
      name: 'Room 102',
      status: 'Vacant',
      isPowerOn: false,
      icalUrl: '에어비앤비_ical_링크_2',
    },
    {
      id: 'r3',
      name: 'Room 201',
      status: 'Vacant',
      isPowerOn: true,
      icalUrl: '에어비앤비_ical_링크_3',
    },
  ],
};

function isHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function isTodayBookedFromEvents(parsed) {
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startOfTomorrow = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate() + 1,
  );

  for (const item of Object.values(parsed)) {
    if (!item || item.type !== 'VEVENT') continue;
    const start = item.start instanceof Date ? item.start : null;
    const end = item.end instanceof Date ? item.end : null;
    if (!start || !end) continue;

    const overlapsToday = start < startOfTomorrow && end > startOfToday;
    if (overlapsToday) return true;
  }

  return false;
}

exports.getDashboardData = (req, res) => {
  res.status(200).json({
    success: true,
    totalSavedAmount: mockDb.totalSavedAmount,
    rooms: mockDb.rooms,
  });
};

exports.toggleDevicePower = (req, res) => {
  const roomId = req.params.id;
  const { isPowerOn } = req.body ?? {};

  if (typeof isPowerOn !== 'boolean') {
    return res.status(400).json({
      success: false,
      message: 'isPowerOn(boolean) 값이 필요합니다.',
    });
  }

  const room = mockDb.rooms.find((r) => r.id === roomId);
  if (!room) {
    return res.status(404).json({ success: false, message: '객실을 찾을 수 없습니다.' });
  }

  room.isPowerOn = isPowerOn;

  if (room.status === 'Vacant' && isPowerOn === false) {
    mockDb.totalSavedAmount += 0.5;
  }

  console.log(`[IoT Command] ${room.name} 전원: ${isPowerOn ? 'ON' : 'OFF'}`);

  return res.status(200).json({
    success: true,
    message: '기기 상태가 변경되었습니다.',
    room,
    newTotalSavedAmount: mockDb.totalSavedAmount,
  });
};

exports.syncCalendarAndAutomate = async (req, res) => {
  const roomId = req.params.id;
  const room = mockDb.rooms.find((r) => r.id === roomId);

  if (!room) {
    return res.status(404).json({ success: false, message: '객실을 찾을 수 없습니다.' });
  }

  try {
    let isTodayBooked = false;

    if (isHttpUrl(room.icalUrl)) {
      const parsed = await ical.async.fromURL(room.icalUrl);
      isTodayBooked = isTodayBookedFromEvents(parsed);
    }

    if (!isTodayBooked && room.status !== 'Vacant') {
      room.status = 'Vacant';
    }

    if (!isTodayBooked && room.status === 'Vacant' && room.isPowerOn) {
      room.isPowerOn = false;
      mockDb.totalSavedAmount += 1.2;
      console.log(`[AI Auto-Action] ${room.name} 빈 객실 감지. 대기전력 자동 차단.`);
    }

    return res.status(200).json({
      success: true,
      message: '캘린더 동기화 및 AI 자동화가 완료되었습니다.',
      room,
      totalSavedAmount: mockDb.totalSavedAmount,
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: '캘린더 동기화 실패' });
  }
};

