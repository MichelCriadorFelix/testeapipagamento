import React, { useEffect, useState, useRef, useMemo } from 'react';
import { collection, query, orderBy, onSnapshot, where, doc, setDoc, limit, increment, updateDoc } from 'firebase/firestore';

import { db, sanitizeForFirestore, handleFirestoreError, OperationType } from '../lib/firebase';
import { useAuth } from '../context/AuthContext';
import { registerPushForAdmin } from '../lib/push';
import { Order, FinanceEntry, CompanyInfo, BillingInfo, BillingProof } from '../types';
import { formatCurrency, formatSizeLabel, compressAndUploadImage, migrateBase64ImageToStorage, calculateDistance, geocodeBrazilianAddress, normalizeText, isBillingAdminEmail } from '../lib/utils';
import { format, subDays, addMonths } from 'date-fns';
import { Link, useSearchParams } from 'react-router-dom';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { 
  BellRing, 
  CheckCircle, 
  Clock, 
  Package, 
  Calendar, 
  Search, 
  Filter, 
  TrendingUp, 
  User, 
  DollarSign, 
  MapPin, 
  Phone, 
  ShieldAlert, 
  List, 
  Info, 
  Settings, 
  ChefHat, 
  Truck, 
  Utensils, 
  TrendingDown, 
  Eye, 
  ExternalLink, 
  RefreshCw, 
  Landmark,
  Save,
  Check,
  Image as ImageIcon,
  Upload,
  Trash2,
  Loader2,
  CheckCircle2,
  AlertCircle,
  Gift,
  Star,
  Plus,
  X,
  AlertTriangle,
  CreditCard,
  Lock
} from 'lucide-react';
import { playNotificationSound, startRing, stopRing } from '../lib/audio';
import { DEFAULT_OPENING_HOURS, DAY_NAMES, DAYS_ORDER } from '../lib/openingHours';

const getAdminStatusLabel = (status: Order['status'], serviceType?: string) => {
  if (status === 'delivering') {
    if (serviceType === 'pickup') return 'Pronto p/ Retirada';
    if (serviceType === 'dine_in') return 'Servindo na Mesa';
    return 'Em Entrega';
  }
  const statusMap: Record<string, string> = {
    pending_payment: 'Aguardando PIX',
    preparing: 'Preparando',
    delivering: 'Em Entrega',
    completed: 'Concluído',
    cancelled: 'Cancelado'
  };
  return statusMap[status] || status;
};

const getAdminServiceTypeLabel = (serviceType?: string) => {
  if (serviceType === 'pickup') return '🛍️ Retirada';
  if (serviceType === 'dine_in') return '🍽️ No Local';
  return '🚚 Delivery';
};

const statusColors = {
  pending_payment: 'bg-orange-100 text-orange-800 border-orange-200',
  preparing: 'bg-blue-100 text-blue-800 border-blue-200',
  delivering: 'bg-purple-100 text-purple-800 border-purple-200',
  completed: 'bg-green-100 text-green-800 border-green-200',
  cancelled: 'bg-red-100 text-red-800 border-red-200'
};

const paymentMap = {
  pix: 'PIX',
  credit: 'Cartão de Crédito',
  debit: 'Cartão de Débito',
  cash: 'Dinheiro na Entrega'
};

type PeriodType = 'yesterday' | 'day' | 'week' | 'month' | 'trimester' | 'semester' | 'year';

const formatRewardLabel = (discountType: 'fixed' | 'percent', discountValue: number) =>
  discountType === 'percent'
    ? `${discountValue}% de desconto`
    : `R$ ${discountValue.toFixed(2).replace('.', ',')} de desconto`;

export default function AdminDashboard() {
  const { user } = useAuth();
  const isBillingAdmin = isBillingAdminEmail(user?.email);
  const [billing, setBilling] = useState<BillingInfo | null>(null);
  const [billingProofs, setBillingProofs] = useState<BillingProof[]>([]);
  const [confirmingProofId, setConfirmingProofId] = useState<string | null>(null);

  useEffect(() => {
    const unsub = onSnapshot(doc(db, 'settings', 'billing'), (snapshot) => {
      setBilling(snapshot.exists() ? (snapshot.data() as BillingInfo) : null);
    });
    return () => unsub();
  }, []);

  useEffect(() => {
    if (!isBillingAdmin) return;
    const q = query(collection(db, 'billingProofs'), orderBy('createdAt', 'desc'));
    const unsub = onSnapshot(q, (snapshot) => {
      setBillingProofs(snapshot.docs.map(d => ({ id: d.id, ...d.data() })) as BillingProof[]);
    });
    return () => unsub();
  }, [isBillingAdmin]);

  const handleConfirmLaunchFee = async () => {
    setConfirmingProofId('launch');
    try {
      await setDoc(doc(db, 'settings', 'billing'), {
        launchFeePaid: true,
        lastConfirmedPaymentAt: Date.now(),
      }, { merge: true });
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, 'settings/billing');
    } finally {
      setConfirmingProofId(null);
    }
  };

  const handleConfirmDueDate = async (requestedDueDate: number, proofId: string) => {
    setConfirmingProofId(proofId);
    try {
      await setDoc(doc(db, 'settings', 'billing'), {
        nextDueDate: requestedDueDate,
      }, { merge: true });
      await setDoc(doc(db, 'billingProofs', proofId), { status: 'confirmed' }, { merge: true });
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, 'settings/billing');
    } finally {
      setConfirmingProofId(null);
    }
  };

  const handleConfirmMonthlyPayment = async (proofId: string) => {
    if (!billing?.nextDueDate) return;
    setConfirmingProofId(proofId);
    try {
      const newDueDate = addMonths(billing.nextDueDate, 1).getTime();
      await setDoc(doc(db, 'settings', 'billing'), {
        nextDueDate: newDueDate,
        lastConfirmedPaymentAt: Date.now(),
      }, { merge: true });
      await setDoc(doc(db, 'billingProofs', proofId), { status: 'confirmed' }, { merge: true });
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, 'settings/billing');
    } finally {
      setConfirmingProofId(null);
    }
  };

  const [notificationPermission, setNotificationPermission] = useState<NotificationPermission | 'unsupported'>('default');
  const [viewingUser, setViewingUser] = useState<any | null>(null);
  const [fixingLocation, setFixingLocation] = useState(false);
  const [fixLocationMessage, setFixLocationMessage] = useState<string | null>(null);

  const handleFixUserLocation = async (u: any) => {
    if (!u.addressStreet || !u.addressCity || !u.addressZip) {
      setFixLocationMessage('Esse cliente não tem rua/cidade/CEP completos no cadastro — peça pra ele preencher em "Meus Dados" primeiro.');
      return;
    }
    setFixingLocation(true);
    setFixLocationMessage(null);
    try {
      const geo = await geocodeBrazilianAddress({
        street: u.addressStreet,
        number: u.addressNumber,
        neighborhood: u.addressNeighborhood,
        city: u.addressCity,
        state: u.addressState,
        zip: u.addressZip,
      });
      if (!geo) {
        setFixLocationMessage('Não consegui localizar esse endereço no mapa, nem pela cidade. Confira se rua, bairro e cidade estão certos no cadastro dele.');
        return;
      }
      const newLat = geo.lat;
      const newLng = geo.lng;

      if (companyInfo.lat && companyInfo.lng) {
        const newDistanceKm = calculateDistance(companyInfo.lat, companyInfo.lng, newLat, newLng) / 1000;
        if (newDistanceKm > 200) {
          setFixLocationMessage(`A nova busca ainda deu uma localização muito distante (${newDistanceKm.toFixed(1)}km) — o endereço cadastrado pode ter algum erro de digitação. Confira com o cliente.`);
          return;
        }
      }

      await setDoc(doc(db, 'users', u.id), { lat: newLat, lng: newLng }, { merge: true });
      setViewingUser({ ...u, lat: newLat, lng: newLng });
      setUsers(prev => prev.map(usr => usr.id === u.id ? { ...usr, lat: newLat, lng: newLng } : usr));
      setFixLocationMessage('Localização corrigida e salva com sucesso!');
    } catch (err) {
      console.error('Failed to fix user location', err);
      setFixLocationMessage('Erro ao buscar a nova localização. Tenta de novo em alguns segundos.');
    } finally {
      setFixingLocation(false);
    }
  };
  const [searchParams, setSearchParams] = useSearchParams();
  const activeTab = (searchParams.get('tab') as 'realtime' | 'history' | 'crm' | 'settings' | 'loyalty' | 'users' | 'billing') || 'realtime';
  const setActiveTab = (tab: 'realtime' | 'history' | 'crm' | 'settings' | 'loyalty' | 'users' | 'billing') => setSearchParams({ tab });
  const [allOrders, setAllOrders] = useState<Order[]>([]);
  const [finances, setFinances] = useState<FinanceEntry[]>([]);
  const [users, setUsers] = useState<any[]>([]);
  const [stats, setStats] = useState({ pending: 0, preparing: 0, todayTotal: 0 });

  // Real neighborhood names already on file from registered customers —
  // used as autocomplete suggestions when adding a bairro fee, so the
  // admin picks a name that actually matches what customers have, instead
  // of typing a new variant that silently collides/mismatches later.
  const [neighborhoodSuggestIdx, setNeighborhoodSuggestIdx] = useState<number | null>(null);
  const [neighborhoodFilterQuery, setNeighborhoodFilterQuery] = useState('');
  const knownNeighborhoods = useMemo(() => {
    const set = new Set<string>();
    users.forEach(u => { if (u.addressNeighborhood) set.add(String(u.addressNeighborhood).trim()); });
    return Array.from(set).sort((a, b) => a.localeCompare(b, 'pt-BR'));
  }, [users]);
  
  // Settings Form State
  const [companyInfo, setCompanyInfo] = useState<CompanyInfo>({
    name: "SENSAÇÃO GOUMERT",
    phone: "21 99999-9999",
    address: "Avenida Prefeito José Amorim, Nº 500, Jardim Meriti, São João de Meriti - RJ",
    pixKey: "12.345.678/0001-90",
    pixKeyName: "SENSAÇÃO GOUMERT Ltda",
    openingHours: DEFAULT_OPENING_HOURS,
    loyaltyEnabled: false,
    loyaltySpendPerPoint: 10,
    loyaltyPointsPerUnit: 1,
    loyaltyRewards: [
      { id: 'reward-30', pointsCost: 30, discountType: 'fixed', discountValue: 5, label: 'R$ 5,00 de desconto' },
      { id: 'reward-50', pointsCost: 50, discountType: 'fixed', discountValue: 10, label: 'R$ 10,00 de desconto' },
      { id: 'reward-100', pointsCost: 100, discountType: 'percent', discountValue: 20, label: '20% de desconto' }
    ]
  });
  const [savingSettings, setSavingSettings] = useState(false);
  const [settingsSavedSuccess, setSettingsSavedSuccess] = useState(false);
  
  const [cepLoading, setCepLoading] = useState(false);
  const [cepStatus, setCepStatus] = useState<{ type: 'idle' | 'loading' | 'success' | 'error', message: string }>({ type: 'idle', message: '' });

  const logoInputRef = useRef<HTMLInputElement>(null);
  const migratingLogoRef = useRef(false);
  const [uploadingLogo, setUploadingLogo] = useState(false);
  const [logoError, setLogoError] = useState(false);

  const handleLogoChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setUploadingLogo(true);
    try {
      const url = await compressAndUploadImage(file, `settings/logo-${Date.now()}.jpg`, 400, 400, 0.85);
      setCompanyInfo(prev => ({ ...prev, logoUrl: url }));
    } catch (err) {
      console.error('Error uploading logo:', err);
      alert('Erro ao enviar a logomarca.');
    } finally {
      setUploadingLogo(false);
      if (logoInputRef.current) {
        logoInputRef.current.value = '';
      }
    }
  };

  const handleRemoveLogo = () => {
    setCompanyInfo(prev => {
      const updated = { ...prev };
      delete updated.logoUrl;
      return updated;
    });
  };

  const handleDayHoursChange = (dayKey: string, field: 'isOpen' | 'openTime' | 'closeTime', value: any) => {
    setCompanyInfo(prev => {
      const hours = prev.openingHours || DEFAULT_OPENING_HOURS;
      return {
        ...prev,
        openingHours: {
          ...hours,
          [dayKey]: {
            ...hours[dayKey],
            [field]: value
          }
        }
      };
    });
  };

  // History Search/Filters State
  const [searchQuery, setSearchQuery] = useState('');
  const [filterStatus, setFilterStatus] = useState<string>('all');
  const [filterPayment, setFilterPayment] = useState<string>('all');
  const [historyPeriod, setHistoryPeriod] = useState<'all' | 'today' | 'week' | 'month'>('all');

  // CRM period selection
  const [crmPeriod, setCrmPeriod] = useState<PeriodType>('month');

  useEffect(() => {
    // A permission prompt triggered without a user gesture (e.g. straight
    // from a mount effect) is routinely suppressed or shown as a barely
    // visible icon by Chrome on Android instead of a real dialog — so this
    // only auto-registers push if permission was already granted in a past
    // session. Getting it granted the first time requires an actual tap,
    // via the "Ativar Notificações" button below.
    if ('Notification' in window) {
      setNotificationPermission(Notification.permission);
      if (Notification.permission === 'granted' && user?.uid) {
        registerPushForAdmin(user.uid);
      }
    }

    // Load Company Settings
    const unsubSettings = onSnapshot(doc(db, 'settings', 'company_info'), (snapshot) => {
      if (snapshot.exists()) {
        const data = snapshot.data() as CompanyInfo;
        setCompanyInfo({
          name: data.name || '',
          phone: data.phone || '',
          address: data.address || '',
          addressZip: data.addressZip || '',
          addressStreet: data.addressStreet || '',
          addressNumber: data.addressNumber || '',
          addressComplement: data.addressComplement || '',
          addressNeighborhood: data.addressNeighborhood || '',
          addressCity: data.addressCity || '',
          addressState: data.addressState || '',
          lat: data.lat,
          lng: data.lng,
          instagramUrl: data.instagramUrl || '',
          pixKey: data.pixKey || '',
          pixKeyName: data.pixKeyName || '',
          logoUrl: data.logoUrl,
          forceClosed: data.forceClosed || false,
          openingHours: data.openingHours || DEFAULT_OPENING_HOURS,
          deliveryRadiusKm: data.deliveryRadiusKm || 0,
          deliveryFee: data.deliveryFee || 0,
          prepTimeEstimate: data.prepTimeEstimate || '',
          deliveryTimeEstimate: data.deliveryTimeEstimate || '',
          neighborhoodFees: data.neighborhoodFees || [
            { name: "PRAÇA GIL", fee: 8 },
            { name: "JARDIM SUMARÉ", fee: 8 },
            { name: "AGOSTINHO PORTO", fee: 10 },
            { name: "VILA ROSALI", fee: 10 },
            { name: "SÃO JOÃO", fee: 10 },
            { name: "PARQUE BARRETO", fee: 10 },
            { name: "PARQUE LAFAIETE", fee: 10 },
            { name: "VILA RUTH", fee: 5 },
            { name: "JARDIM NOIA", fee: 5 },
            { name: "RODO", fee: 5 },
            { name: "VILA SAO JOAO", fee: 5 },
            { name: "JARDIM PARAISO", fee: 5 },
            { name: "PRAÇA DA BANDEIRA", fee: 8 },
            { name: "METROPOLES", fee: 6 },
            { name: "VILAR DOS TELES", fee: 6 },
            { name: "JARDIM IRIS", fee: 7 },
            { name: "JARDIM MERITI", fee: 7 },
            { name: "JARDIM BOTANICO", fee: 6 },
            { name: "OLAVO BILAC", fee: 10 }
          ],
          loyaltyEnabled: data.loyaltyEnabled || false,
          loyaltySpendPerPoint: data.loyaltySpendPerPoint ?? 10,
          loyaltyPointsPerUnit: data.loyaltyPointsPerUnit ?? 1,
          loyaltyRewards: data.loyaltyRewards ?? [
            { id: 'reward-30', pointsCost: 30, discountType: 'fixed', discountValue: 5, label: 'R$ 5,00 de desconto' },
            { id: 'reward-50', pointsCost: 50, discountType: 'fixed', discountValue: 10, label: 'R$ 10,00 de desconto' },
            { id: 'reward-100', pointsCost: 100, discountType: 'percent', discountValue: 20, label: '20% de desconto' }
          ]
        });

        // Self-healing migration: an old logo saved as base64 directly on
        // this document makes it huge, and this same doc is fetched on
        // nearly every page in the app — that's the main reason the whole
        // app (not just the menu) can take a long time to load. Move it to
        // Storage once and swap in the short URL.
        if (data.logoUrl?.startsWith('data:image') && !migratingLogoRef.current) {
          migratingLogoRef.current = true;
          migrateBase64ImageToStorage(data.logoUrl, `settings/logo-${Date.now()}.jpg`)
            .then(url => setDoc(doc(db, 'settings', 'company_info'), { logoUrl: url }, { merge: true }))
            .catch(err => console.error('Falha ao migrar a logo da empresa', err))
            .finally(() => { migratingLogoRef.current = false; });
        }
      }
    }, (err) => {
      handleFirestoreError(err, OperationType.GET, 'settings/company_info');
    });

    // Load finances for cost analysis
    const unsubFinances = onSnapshot(query(collection(db, 'finances'), orderBy('date', 'desc'), limit(500)), (snapshot) => {
      setFinances(snapshot.docs.map(d => ({ id: d.id, ...d.data() } as FinanceEntry)));
    }, (err) => {
      handleFirestoreError(err, OperationType.LIST, 'finances');
    });

    // Load ALL orders for dynamic list filtering & history & CRM
    const qAll = query(
      collection(db, 'pix_test_orders'),
      orderBy('createdAt', 'desc'),
      limit(2000)
    );

    const unsubscribeOrders = onSnapshot(qAll, (snapshot) => {
      const orders = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as Order));
      setAllOrders(orders);

      // Realtime stats for today
      const todayStart = new Date();
      todayStart.setHours(0, 0, 0, 0);
      const todayStartMs = todayStart.getTime();

      let pending = 0;
      let preparing = 0;
      let todayTotal = 0;

      orders.forEach(order => {
        if (order.status === 'pending_payment') pending++;
        if (order.status === 'preparing') preparing++;
        if (order.createdAt >= todayStartMs && order.status === 'completed') {
          todayTotal += order.total;
        }
      });

      // Sound notification for new orders
      let hasNewRecentOrder = false;
      snapshot.docChanges().forEach((change) => {
        if (change.type === 'added') {
          const data = change.doc.data();
          // Created in the last 15 seconds
          if (data && data.createdAt && (Date.now() - data.createdAt < 15000)) {
            hasNewRecentOrder = true;
          }
        }
      });

      if (hasNewRecentOrder && 'Notification' in window && Notification.permission === 'granted') {
        new Notification('Novo Pedido Recebido!', {
          body: 'Você recebeu um novo pedido para analisar.',
          icon: 'https://raw.githubusercontent.com/MichelCriadorFelix/RESTAURANTE-/1975716dd80f7c608f07a4d6ebb4628f6da7d780/public/icon-192.png'
        });
      }

      // Ring whenever there's at least one order still awaiting approval —
      // not just ones created in the last 15s. Otherwise, opening the app
      // some time after a push notification (unlock phone, tap it, wait
      // for the page to load) means the order is no longer "recent" by the
      // time the listener connects, and the ring never starts even though
      // the order is still sitting there waiting.
      const unackPaidPix = orders.filter(o => o.paidAt && !o.pixAckAt && o.status === 'preparing').length;
      if (pending > 0 || unackPaidPix > 0) {
        startRing();
      } else {
        stopRing();
      }

      setStats({ pending, preparing, todayTotal });
    }, (err) => {
      handleFirestoreError(err, OperationType.LIST, 'pix_test_orders');
    });

    // Load All Users for Team Management
    const unsubUsers = onSnapshot(query(collection(db, 'users'), limit(500)), (snapshot) => {
      setUsers(snapshot.docs.map(d => ({ id: d.id, ...d.data() })));
    }, (err) => {
      handleFirestoreError(err, OperationType.LIST, 'users');
    });

    return () => {
      unsubSettings();
      unsubFinances();
      unsubscribeOrders();
      unsubUsers();
      stopRing();
    };
  }, []);

  const handleEnableNotifications = async () => {
    if (!('Notification' in window)) {
      setNotificationPermission('unsupported');
      return;
    }
    // Called directly from a tap — this is what makes Chrome show a real
    // permission dialog instead of silently suppressing it.
    const permission = await Notification.requestPermission();
    setNotificationPermission(permission);
    if (permission === 'granted' && user?.uid) {
      await registerPushForAdmin(user.uid);
    }
  };

  const lookupCompanyCEP = async (cepDigits: string) => {
    if (cepDigits.length !== 8) return;
    setCepLoading(true);
    setCepStatus({ type: 'loading', message: 'Buscando CEP...' });
    try {
      const response = await fetch(`https://viacep.com.br/ws/${cepDigits}/json/`);
      const data = await response.json();

      if (data.erro) {
        setCepStatus({ type: 'error', message: 'CEP não encontrado no ViaCEP.' });
        setCepLoading(false);
        return;
      }

      const street = data.logradouro || '';
      const neighborhood = data.bairro || '';
      const city = data.localidade || '';
      const state = data.uf || '';
      const formattedZip = `${cepDigits.slice(0, 5)}-${cepDigits.slice(5)}`;

      setCepStatus({ type: 'loading', message: 'CEP encontrado! Buscando localização para o raio...' });

      // Geocode using OpenStreetMap
      let lat: number | undefined;
      let lng: number | undefined;

      try {
        const geo = await geocodeBrazilianAddress({ street, neighborhood, city, state, zip: formattedZip });
        if (geo) {
          lat = geo.lat;
          lng = geo.lng;
        }
      } catch (e) {
        console.error('Geocoding error:', e);
      }

      setCompanyInfo(prev => {
        const updatedStreet = street || prev.addressStreet || '';
        const updatedNeighborhood = neighborhood || prev.addressNeighborhood || '';
        const updatedCity = city || prev.addressCity || '';
        const updatedState = state || prev.addressState || '';
        const updatedNumber = prev.addressNumber || '';

        const fullAddress = [
          updatedStreet && updatedNumber ? `${updatedStreet}, ${updatedNumber}` : updatedStreet,
          prev.addressComplement,
          updatedNeighborhood,
          updatedCity && updatedState ? `${updatedCity} - ${updatedState}` : updatedCity,
          `CEP: ${formattedZip}`
        ].filter(Boolean).join(' - ');

        return {
          ...prev,
          addressZip: formattedZip,
          addressStreet: updatedStreet,
          addressNeighborhood: updatedNeighborhood,
          addressCity: updatedCity,
          addressState: updatedState,
          address: fullAddress,
          lat: lat !== undefined ? lat : prev.lat,
          lng: lng !== undefined ? lng : prev.lng,
        };
      });

      if (lat && lng) {
        setCepStatus({ type: 'success', message: 'Endereço e localização (GPS) identificados!' });
      } else {
        setCepStatus({ type: 'success', message: 'Endereço identificado e preenchido!' });
      }
    } catch (err) {
      setCepStatus({ type: 'error', message: 'Erro ao buscar o CEP.' });
    } finally {
      setCepLoading(false);
    }
  };

  const handleCompanyCepChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const rawValue = e.target.value;
    const digits = rawValue.replace(/\D/g, '').slice(0, 8);
    let formatted = digits;
    if (digits.length > 5) {
      formatted = `${digits.slice(0, 5)}-${digits.slice(5)}`;
    }
    setCompanyInfo(prev => ({ ...prev, addressZip: formatted }));
    if (digits.length === 8) {
      lookupCompanyCEP(digits);
    } else {
      setCepStatus({ type: 'idle', message: '' });
    }
  };

  const handleSaveSettings = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    setSavingSettings(true);
    try {
      const fullAddress = [
        companyInfo.addressStreet && companyInfo.addressNumber ? `${companyInfo.addressStreet}, ${companyInfo.addressNumber}` : companyInfo.addressStreet,
        companyInfo.addressComplement,
        companyInfo.addressNeighborhood,
        companyInfo.addressCity && companyInfo.addressState ? `${companyInfo.addressCity} - ${companyInfo.addressState}` : companyInfo.addressCity,
        companyInfo.addressZip ? `CEP: ${companyInfo.addressZip}` : ''
      ].filter(Boolean).join(' - ');

      let storeLat = companyInfo.lat;
      let storeLng = companyInfo.lng;

      if (!storeLat || !storeLng) {
        try {
          const zipToSearch = companyInfo.addressZip || '25570-162';
          const geo = await geocodeBrazilianAddress({
            street: companyInfo.addressStreet,
            number: companyInfo.addressNumber,
            neighborhood: companyInfo.addressNeighborhood,
            city: companyInfo.addressCity,
            state: companyInfo.addressState,
            zip: zipToSearch,
          });
          if (geo) {
            storeLat = geo.lat;
            storeLng = geo.lng;
          }
        } catch (e) {
          console.error('Geocoding on save error:', e);
        }
      }

      const updatedCompanyInfo = {
        ...companyInfo,
        address: fullAddress || companyInfo.address,
        lat: storeLat,
        lng: storeLng
      };

      const dataToSave = sanitizeForFirestore(updatedCompanyInfo);
      await setDoc(doc(db, 'settings', 'company_info'), dataToSave);
      setSettingsSavedSuccess(true);
      setTimeout(() => setSettingsSavedSuccess(false), 3000);
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, 'settings/company_info');
    } finally {
      setSavingSettings(false);
    }
  };

  // --- Calculations for Tab 2: Orders History ---
  const filteredHistoryOrders = useMemo(() => allOrders.filter(order => {
    const matchSearch = 
      order.userName.toLowerCase().includes(searchQuery.toLowerCase()) ||
      order.id.toLowerCase().includes(searchQuery.toLowerCase()) ||
      (order.address && order.address.toLowerCase().includes(searchQuery.toLowerCase()));

    const matchStatus = filterStatus === 'all' || order.status === filterStatus;
    const matchPayment = filterPayment === 'all' || order.paymentMethod === filterPayment;

    let matchPeriod = true;
    if (historyPeriod === 'today') {
      const todayStart = new Date();
      todayStart.setHours(0, 0, 0, 0);
      matchPeriod = order.createdAt >= todayStart.getTime();
    } else if (historyPeriod === 'week') {
      const weekAgo = subDays(new Date(), 7);
      matchPeriod = order.createdAt >= weekAgo.getTime();
    } else if (historyPeriod === 'month') {
      const monthAgo = subDays(new Date(), 30);
      matchPeriod = order.createdAt >= monthAgo.getTime();
    }

    return matchSearch && matchStatus && matchPayment && matchPeriod;
  }), [allOrders, searchQuery, filterStatus, filterPayment, historyPeriod]);

  // --- Calculations for Tab 3: CRM ---
  // Returns a bounded range rather than just a start — "yesterday" needs
  // an end boundary too (start of today), unlike every other period which
  // is open-ended up to now.
  const getCrmPeriodRange = (period: PeriodType): { start: number; end: number } => {
    const now = new Date();
    if (period === 'yesterday') {
      const startOfToday = new Date();
      startOfToday.setHours(0, 0, 0, 0);
      return { start: subDays(startOfToday, 1).getTime(), end: startOfToday.getTime() };
    }
    if (period === 'day') {
      const start = new Date();
      start.setHours(0, 0, 0, 0);
      return { start: start.getTime(), end: now.getTime() };
    }
    if (period === 'week') return { start: subDays(now, 7).getTime(), end: now.getTime() };
    if (period === 'month') return { start: subDays(now, 30).getTime(), end: now.getTime() };
    if (period === 'trimester') return { start: subDays(now, 90).getTime(), end: now.getTime() };
    if (period === 'semester') return { start: subDays(now, 180).getTime(), end: now.getTime() };
    if (period === 'year') return { start: subDays(now, 365).getTime(), end: now.getTime() };
    return { start: 0, end: now.getTime() };
  };

  const {
    crmRevenue,
    crmCompletedCount,
    crmAverageTicket,
    crmCancelledCount,
    crmTotalCount,
    crmFixedCosts,
    crmVariableCosts,
    crmTotalCosts,
    crmNetProfit,
    topCrmProducts,
    maxProductQuantity,
    paymentBreakdown,
    dailyRevenueBreakdown
  } = useMemo(() => {
    const { start: startMs, end: endMs } = getCrmPeriodRange(crmPeriod);
    const crmOrders = allOrders.filter(o => o.createdAt >= startMs && o.createdAt < endMs);
    const crmCompletedOrders = crmOrders.filter(o => o.status === 'completed');
    const crmCancelledOrders = crmOrders.filter(o => o.status === 'cancelled');

    const revenue = crmCompletedOrders.reduce((sum, o) => sum + o.total, 0);
    const completedCount = crmCompletedOrders.length;
    const averageTicket = completedCount > 0 ? revenue / completedCount : 0;

    // Finances
    const crmFinances = finances.filter(f => f.date >= startMs && f.date < endMs);
    const fixedCosts = crmFinances.filter(f => f.type === 'fixed_cost').reduce((sum, f) => sum + f.amount, 0);
    const varCosts = crmFinances.filter(f => f.type === 'variable_cost').reduce((sum, f) => sum + f.amount, 0);
    const totalCosts = fixedCosts + varCosts;
    const netProfit = revenue - totalCosts;

    // Day-by-day revenue breakdown, only meaningful for the 7/30-day
    // windows — a per-day bar for a semester/year would be unreadable.
    // Days with zero orders still get a bucket so gaps are visible rather
    // than silently skipped.
    let dailyBreakdown: { label: string; Faturamento: number }[] = [];
    if (crmPeriod === 'week' || crmPeriod === 'month') {
      const days = crmPeriod === 'week' ? 7 : 30;
      const now = new Date();
      const buckets = Array.from({ length: days }, (_, idx) => {
        const d = subDays(now, days - 1 - idx);
        return { key: format(d, 'yyyy-MM-dd'), label: format(d, 'dd/MM'), Faturamento: 0 };
      });
      const byKey = Object.fromEntries(buckets.map(b => [b.key, b]));
      crmCompletedOrders.forEach(o => {
        const key = format(new Date(o.createdAt), 'yyyy-MM-dd');
        if (byKey[key]) byKey[key].Faturamento += o.total;
      });
      dailyBreakdown = buckets.map(({ label, Faturamento }) => ({ label, Faturamento }));
    }

    // Top Products
    const productQuantities: { [key: string]: { name: string; quantity: number; revenue: number } } = {};
    crmCompletedOrders.forEach(order => {
      order.items.forEach(item => {
        const pid = item.product.id;
        if (!productQuantities[pid]) {
          productQuantities[pid] = { name: item.product.name, quantity: 0, revenue: 0 };
        }
        productQuantities[pid].quantity += item.quantity;
        productQuantities[pid].revenue += item.totalPrice;
      });
    });

    const topProducts = Object.values(productQuantities)
      .sort((a, b) => b.quantity - a.quantity)
      .slice(0, 5);

    const maxQty = topProducts.length > 0 ? Math.max(...topProducts.map(p => p.quantity)) : 1;

    // Payment Methods
    const pBreakdown = { pix: 0, credit: 0, debit: 0, cash: 0 };
    crmCompletedOrders.forEach(o => {
      const method = o.paymentMethod || 'pix';
      if (pBreakdown[method] !== undefined) {
        pBreakdown[method] += o.total;
      }
    });

    return {
      crmRevenue: revenue,
      crmCompletedCount: completedCount,
      crmAverageTicket: averageTicket,
      crmCancelledCount: crmCancelledOrders.length,
      crmTotalCount: crmOrders.length,
      crmFixedCosts: fixedCosts,
      crmVariableCosts: varCosts,
      crmTotalCosts: totalCosts,
      crmNetProfit: netProfit,
      topCrmProducts: topProducts,
      maxProductQuantity: maxQty,
      paymentBreakdown: pBreakdown,
      dailyRevenueBreakdown: dailyBreakdown
    };
  }, [allOrders, finances, crmPeriod]);

  const { activeOrdersCount, activeOrdersList } = useMemo(() => {
    const list = allOrders.filter(o => o.status !== 'completed' && o.status !== 'cancelled');
    return {
      activeOrdersCount: list.length,
      activeOrdersList: list
    };
  }, [allOrders]);

  // Recharts Data for selected period
  const rechartsCrmData = [
    { name: 'Faturamento', Valor: crmRevenue, fill: '#10b981' },
    { name: 'Custo Fixo', Valor: crmFixedCosts, fill: '#ef4444' },
    { name: 'Custo Variável', Valor: crmVariableCosts, fill: '#f97316' },
    { name: 'Lucro Líquido', Valor: crmNetProfit, fill: '#3b82f6' }
  ];

  return (
    <div className="max-w-7xl mx-auto px-4 py-6">
      {/* Top Header */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center mb-6 gap-4 border-b border-gray-100 pb-4">
        <div>
          <h1 className="text-xl font-black text-gray-900 uppercase tracking-tight">{companyInfo.name}</h1>
          <p className="text-xs text-gray-500 font-semibold uppercase tracking-widest mt-0.5">Admin Central de Operações</p>
        </div>
        <div className="flex items-center space-x-3">
          {notificationPermission !== 'granted' && notificationPermission !== 'unsupported' && (
            <button
              onClick={handleEnableNotifications}
              className={`px-2.5 py-1 rounded text-[9px] font-black uppercase tracking-widest flex items-center gap-1.5 transition-colors cursor-pointer ${
                notificationPermission === 'denied'
                  ? 'bg-red-50 text-red-600 border border-red-200 hover:bg-red-100'
                  : 'bg-amber-100 text-amber-700 border border-amber-200 animate-pulse hover:bg-amber-200'
              }`}
              title={notificationPermission === 'denied' ? 'Bloqueado — ative manualmente nas permissões do site' : 'Toque para ativar notificações de novos pedidos'}
            >
              <BellRing size={11} />
              {notificationPermission === 'denied' ? 'Notificações Bloqueadas' : 'Ativar Notificações'}
            </button>
          )}
          <span className="px-2.5 py-1 bg-green-100 text-green-700 border border-green-200 rounded text-[9px] font-black uppercase tracking-widest animate-pulse flex items-center">
            <span className="w-1.5 h-1.5 bg-green-600 rounded-full mr-1.5 inline-block"></span>
            Conexão Live
          </span>
        </div>
      </div>

      {/* Tabs Switcher Navigation */}
      <div className="flex flex-wrap border-b border-gray-200 mb-6 gap-1">
        <button
          onClick={() => setActiveTab('realtime')}
          className={`px-4 py-2.5 text-xs font-black uppercase tracking-wider border-b-2 transition-all flex items-center gap-2 ${
            activeTab === 'realtime' 
              ? 'border-brand text-brand bg-brand/5' 
              : 'border-transparent text-gray-500 hover:text-gray-900 hover:bg-gray-50'
          }`}
        >
          <BellRing size={16} />
          <span>Monitore em Tempo Real</span>
          {activeOrdersCount > 0 && (
            <span className="bg-brand text-white text-[9px] px-1.5 py-0.5 rounded-full font-bold ml-1">
              {activeOrdersCount}
            </span>
          )}
        </button>

        <button
          onClick={() => setActiveTab('history')}
          className={`px-4 py-2.5 text-xs font-black uppercase tracking-wider border-b-2 transition-all flex items-center gap-2 ${
            activeTab === 'history' 
              ? 'border-brand text-brand bg-brand/5' 
              : 'border-transparent text-gray-500 hover:text-gray-900 hover:bg-gray-50'
          }`}
        >
          <List size={16} />
          <span>Histórico de Pedidos</span>
        </button>

        <button
          onClick={() => setActiveTab('crm')}
          className={`px-4 py-2.5 text-xs font-black uppercase tracking-wider border-b-2 transition-all flex items-center gap-2 ${
            activeTab === 'crm' 
              ? 'border-brand text-brand bg-brand/5' 
              : 'border-transparent text-gray-500 hover:text-gray-900 hover:bg-gray-50'
          }`}
        >
          <TrendingUp size={16} />
          <span>CRM & Analítico</span>
        </button>

        <button
          onClick={() => setActiveTab('settings')}
          className={`px-4 py-2.5 text-xs font-black uppercase tracking-wider border-b-2 transition-all flex items-center gap-2 ${
            activeTab === 'settings' 
              ? 'border-brand text-brand bg-brand/5' 
              : 'border-transparent text-gray-500 hover:text-gray-900 hover:bg-gray-50'
          }`}
        >
          <Settings size={16} />
          <span>Dados da Empresa</span>
        </button>

        <button
          onClick={() => setActiveTab('loyalty')}
          className={`px-4 py-2.5 text-xs font-black uppercase tracking-wider border-b-2 transition-all flex items-center gap-2 ${
            activeTab === 'loyalty'
              ? 'border-brand text-brand bg-brand/5'
              : 'border-transparent text-gray-500 hover:text-gray-900 hover:bg-gray-50'
          }`}
        >
          <Gift size={16} />
          <span>Fidelidade</span>
        </button>

        <button
          onClick={() => setActiveTab('users')}
          className={`px-4 py-2.5 text-xs font-black uppercase tracking-wider border-b-2 transition-all flex items-center gap-2 ${
            activeTab === 'users'
              ? 'border-brand text-brand bg-brand/5'
              : 'border-transparent text-gray-500 hover:text-gray-900 hover:bg-gray-50'
          }`}
        >
          <ShieldAlert size={16} />
          <span>Gerenciar Equipe</span>
        </button>

        {isBillingAdmin && (
          <button
            onClick={() => setActiveTab('billing')}
            className={`px-4 py-2.5 text-xs font-black uppercase tracking-wider border-b-2 transition-all flex items-center gap-2 ${
              activeTab === 'billing'
                ? 'border-brand text-brand bg-brand/5'
                : 'border-transparent text-gray-500 hover:text-gray-900 hover:bg-gray-50'
            }`}
          >
            <CreditCard size={16} />
            <span>Cobrança</span>
            {billingProofs.some(p => p.status === 'pending') && (
              <span className="bg-red-500 text-white text-[9px] px-1.5 py-0.5 rounded-full font-bold ml-1">
                {billingProofs.filter(p => p.status === 'pending').length}
              </span>
            )}
          </button>
        )}
      </div>

      {/* TAB 1: REAL-TIME MONITOR */}
      {activeTab === 'realtime' && (
        <div className="space-y-6">
          {/* Top Quick Stats Grid */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div className="bg-white p-4 rounded-xl border border-gray-200 shadow-sm flex items-center gap-4">
              <div className="p-3 bg-orange-100 text-orange-600 rounded-lg">
                <BellRing size={20} className="animate-bounce" />
              </div>
              <div>
                <p className="text-[9px] text-gray-400 font-black uppercase tracking-widest leading-none">Aguardando PIX</p>
                <p className="text-xl font-black text-gray-900 mt-1">{stats.pending}</p>
                <p className="text-[9px] text-orange-600 font-bold mt-0.5">Pendentes de aprovação</p>
              </div>
            </div>

            <div className="bg-white p-4 rounded-xl border border-gray-200 shadow-sm flex items-center gap-4">
              <div className="p-3 bg-blue-100 text-blue-600 rounded-lg">
                <ChefHat size={20} />
              </div>
              <div>
                <p className="text-[9px] text-gray-400 font-black uppercase tracking-widest leading-none">Em Preparo</p>
                <p className="text-xl font-black text-gray-900 mt-1">{stats.preparing}</p>
                <p className="text-[9px] text-blue-600 font-bold mt-0.5">Em fritura/cozinha</p>
              </div>
            </div>

            <div className="bg-white p-4 rounded-xl border border-gray-200 shadow-sm flex items-center gap-4">
              <div className="p-3 bg-green-100 text-green-600 rounded-lg">
                <DollarSign size={20} />
              </div>
              <div>
                <p className="text-[9px] text-gray-400 font-black uppercase tracking-widest leading-none">Faturado Hoje</p>
                <p className="text-xl font-black text-green-600 mt-1">{formatCurrency(stats.todayTotal)}</p>
                <p className="text-[9px] text-green-600 font-bold mt-0.5">Apenas pedidos concluídos</p>
              </div>
            </div>
          </div>

          {/* Active Orders List */}
          <div className="bg-white border border-gray-200 rounded-xl shadow-sm overflow-hidden">
            <div className="bg-gray-50/70 px-4 py-3 border-b border-gray-200 flex justify-between items-center">
              <h3 className="font-black text-xs text-gray-900 uppercase tracking-widest flex items-center">
                <Package size={14} className="mr-2 text-brand" /> Pedidos em Andamento
              </h3>
              <span className="text-[10px] bg-brand/10 text-brand px-2 py-0.5 rounded font-bold uppercase tracking-wider">
                Total: {activeOrdersCount}
              </span>
            </div>

            {activeOrdersCount === 0 ? (
              <div className="p-10 text-center text-xs text-gray-400 font-medium flex flex-col items-center justify-center space-y-2">
                <Package size={36} className="text-gray-300" />
                <p>Nenhum pedido em andamento no momento.</p>
                <p className="text-[10px] text-gray-400">Os novos pedidos aparecerão aqui em tempo real com alertas sonoros!</p>
              </div>
            ) : (
              <div className="divide-y divide-gray-100">
                {activeOrdersList.map(order => {
                  const isNew = order.status === 'pending_payment';
                  const isPaidPix = !!order.paidAt && !order.pixAckAt;
                  return (
                  <Link
                    key={order.id}
                    to={`/admin/orders/${order.id}`}
                    className={`p-4 flex flex-col sm:flex-row sm:items-center justify-between transition-colors gap-3 block ${
                      isNew ? 'bg-amber-50 border-l-4 border-amber-400 hover:bg-amber-100/70' : isPaidPix ? 'bg-emerald-50 border-l-4 border-emerald-500 ring-2 ring-emerald-400 animate-pulse hover:bg-emerald-100/70' : 'hover:bg-gray-50'
                    }`}
                  >
                    <div className="flex items-start gap-3">
                      <div className={`w-10 h-10 rounded flex items-center justify-center border flex-shrink-0 ${
                        isNew ? 'bg-amber-400 border-amber-400 animate-pulse' : 'bg-gray-100 text-gray-500 border-gray-200'
                      }`}>
                        <Utensils size={18} className={isNew ? 'text-white' : 'text-brand'} />
                      </div>
                      <div>
                        <div className="flex items-center gap-2 flex-wrap">
                          {isPaidPix && (
                            <span className="flex items-center gap-1 text-[9px] font-black uppercase tracking-wider text-white bg-emerald-600 px-1.5 py-0.5 rounded">
                              <BellRing size={10} /> Pago via PIX
                            </span>
                          )}
                          {isNew && (
                            <span className="flex items-center gap-1 text-[9px] font-black uppercase tracking-wider text-white bg-amber-500 px-1.5 py-0.5 rounded animate-pulse">
                              <BellRing size={10} /> Novo Pedido
                            </span>
                          )}
                          <p className="text-xs font-black text-gray-900 uppercase">
                            {order.userName}
                          </p>
                          <span className="text-[9px] font-black uppercase tracking-wider text-brand bg-brand/10 px-1.5 py-0.5 rounded border border-brand/20">
                            {getAdminServiceTypeLabel(order.serviceType)}
                          </span>
                          <span className="text-[10px] text-gray-400 font-bold uppercase">
                            #{order.id.slice(-6).toUpperCase()}
                          </span>
                        </div>
                        <p className="text-[10px] text-gray-500 mt-1 font-semibold leading-relaxed max-w-lg truncate" translate="no">
                          {order.items.map(i => `${i.quantity}x ${i.product.name}`).join(' • ')}
                        </p>
                        {order.notes && (
                          <div className="mt-1 px-2 py-0.5 bg-amber-50 border border-amber-100 text-amber-800 text-[9px] font-bold rounded flex items-center gap-1 uppercase tracking-wider max-w-md">
                            <span className="inline-block w-1 h-1 rounded-full bg-amber-500 animate-pulse"></span>
                            Obs: {order.notes}
                          </div>
                        )}
                        {order.deliveryFeePending && (
                          <div className="mt-1 px-2 py-0.5 bg-amber-50 border border-amber-100 text-amber-800 text-[9px] font-bold rounded flex items-center gap-1 uppercase tracking-wider max-w-md">
                            <span className="inline-block w-1 h-1 rounded-full bg-amber-500 animate-pulse"></span>
                            ⚠️ Bairro novo — avaliar entrega
                          </div>
                        )}
                        <p className="text-[9px] text-gray-400 font-bold mt-1 uppercase tracking-wider">
                          {format(new Date(order.createdAt), 'dd/MM/yyyy HH:mm')} • {paymentMap[order.paymentMethod || 'pix']}
                          {order.paymentMethod === 'cash' && order.changeRequested && (
                            <span className="text-brand font-black ml-1">
                              (Troco p/ {formatCurrency(order.changeFor || 0)})
                            </span>
                          )}
                        </p>
                      </div>
                    </div>

                    <div className="flex sm:flex-col items-end justify-between sm:justify-center gap-1.5 border-t sm:border-0 pt-2 sm:pt-0 border-gray-50">
                      <span className={`px-2 py-0.5 rounded text-[9px] font-black uppercase border tracking-wider ${statusColors[order.status]}`}>
                        {getAdminStatusLabel(order.status, order.serviceType)}
                      </span>
                      <p className="font-black text-sm text-gray-900">{formatCurrency(order.total)}</p>
                      {isPaidPix && (
                        <button
                          type="button"
                          onClick={(e) => { e.preventDefault(); e.stopPropagation(); updateDoc(doc(db, 'pix_test_orders', order.id), { pixAckAt: Date.now() }).catch(console.error); }}
                          className="px-2 py-1 rounded bg-emerald-600 text-white text-[9px] font-black uppercase tracking-wider hover:bg-emerald-700"
                        >
                          Ciente
                        </button>
                      )}
                    </div>
                  </Link>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}

      {/* TAB 2: DETAILED ORDERS HISTORY */}
      {activeTab === 'history' && (
        <div className="space-y-4">
          {/* Filters Bar */}
          <div className="bg-white p-4 border border-gray-200 rounded-xl shadow-sm space-y-3">
            <h3 className="font-black text-[10px] text-gray-500 uppercase tracking-widest mb-1">Buscar & Filtrar no Histórico</h3>
            
            <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
              {/* Search Bar */}
              <div className="relative sm:col-span-2">
                <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
                <input
                  type="text"
                  placeholder="Buscar por cliente, ID do pedido, ou endereço..."
                  value={searchQuery}
                  onChange={e => setSearchQuery(e.target.value)}
                  className="w-full border border-gray-200 bg-gray-50 rounded-lg py-1.5 pl-9 pr-3 text-xs placeholder:text-gray-400 focus:ring-brand focus:border-brand"
                />
              </div>

              {/* Status Dropdown */}
              <div>
                <select
                  value={filterStatus}
                  onChange={e => setFilterStatus(e.target.value)}
                  className="w-full border border-gray-200 bg-gray-50 rounded-lg py-1.5 px-3 text-xs focus:ring-brand focus:border-brand font-semibold text-gray-700"
                >
                  <option value="all">Todos os Status</option>
                  <option value="pending_payment">Aguardando PIX</option>
                  <option value="preparing">Preparando</option>
                  <option value="delivering">Em Entrega</option>
                  <option value="completed">Concluídos</option>
                  <option value="cancelled">Cancelados</option>
                </select>
              </div>

              {/* Payment Method Dropdown */}
              <div>
                <select
                  value={filterPayment}
                  onChange={e => setFilterPayment(e.target.value)}
                  className="w-full border border-gray-200 bg-gray-50 rounded-lg py-1.5 px-3 text-xs focus:ring-brand focus:border-brand font-semibold text-gray-700"
                >
                  <option value="all">Formas de Pagamento</option>
                  <option value="pix">PIX</option>
                  <option value="credit">Cartão de Crédito</option>
                  <option value="debit">Cartão de Débito</option>
                  <option value="cash">Dinheiro</option>
                </select>
              </div>
            </div>

            {/* Period Quick Filter Tabs */}
            <div className="flex flex-wrap items-center gap-1.5 pt-2 border-t border-gray-100">
              <span className="text-[9px] text-gray-400 font-black uppercase tracking-widest mr-2">Período:</span>
              {[
                { id: 'all', label: 'Todo o Histórico' },
                { id: 'today', label: 'Hoje' },
                { id: 'week', label: 'Últimos 7 dias' },
                { id: 'month', label: 'Últimos 30 dias' }
              ].map(periodTab => (
                <button
                  key={periodTab.id}
                  onClick={() => setHistoryPeriod(periodTab.id as any)}
                  className={`px-3 py-1 text-[9px] font-black uppercase tracking-wider rounded border transition-colors ${
                    historyPeriod === periodTab.id
                      ? 'bg-brand text-white border-brand'
                      : 'bg-white border-gray-200 text-gray-500 hover:text-gray-900 hover:bg-gray-50'
                  }`}
                >
                  {periodTab.label}
                </button>
              ))}
            </div>
          </div>

          {/* Orders History Table */}
          <div className="bg-white border border-gray-200 rounded-xl shadow-sm overflow-hidden">
            <div className="p-3 bg-gray-50/70 border-b border-gray-200 flex justify-between items-center">
              <span className="text-xs font-black uppercase tracking-widest text-gray-900 flex items-center">
                <List size={14} className="mr-2 text-brand" /> Resultados Encontrados
              </span>
              <span className="text-[10px] bg-gray-200 text-gray-700 px-2 py-0.5 rounded font-black">
                {filteredHistoryOrders.length}
              </span>
            </div>

            {filteredHistoryOrders.length === 0 ? (
              <div className="p-12 text-center text-xs text-gray-400 font-semibold space-y-2">
                <Package size={32} className="mx-auto text-gray-300" />
                <p>Nenhum pedido atende aos filtros selecionados.</p>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse">
                  <thead>
                    <tr className="border-b border-gray-200 bg-gray-50/40 text-[9px] font-black text-gray-400 uppercase tracking-widest">
                      <th className="p-3 pl-4">ID / Data</th>
                      <th className="p-3">Cliente / Contato</th>
                      <th className="p-3">Itens do Pedido</th>
                      <th className="p-3">Pagamento</th>
                      <th className="p-3">Status</th>
                      <th className="p-3 text-right pr-4">Total</th>
                      <th className="p-3 text-center">Ações</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100 text-xs font-medium text-gray-700">
                    {filteredHistoryOrders.map(order => (
                      <tr key={order.id} className="hover:bg-gray-50/60 transition-colors">
                        <td className="p-3 pl-4">
                          <div className="flex items-center gap-1 mb-0.5">
                            <span className="font-black text-gray-950 uppercase">
                              #{order.id.slice(-6).toUpperCase()}
                            </span>
                            <span className="text-[8px] font-black uppercase tracking-wider text-brand bg-brand/10 px-1 py-0.2 rounded border border-brand/20">
                              {getAdminServiceTypeLabel(order.serviceType)}
                            </span>
                          </div>
                          <span className="text-[9px] text-gray-400 font-bold block">
                            {format(new Date(order.createdAt), 'dd/MM/yyyy HH:mm')}
                          </span>
                        </td>
                        <td className="p-3">
                          <span className="font-bold text-gray-900 block">{order.userName}</span>
                          {order.address && (
                            <span className="text-[10px] text-gray-400 font-semibold block max-w-xs truncate leading-normal" title={order.address}>
                              <MapPin size={10} className="inline mr-0.5 -mt-0.5 text-gray-400" />
                              {order.address}
                            </span>
                          )}
                        </td>
                        <td className="p-3">
                          <div className="space-y-0.5">
                            {order.items.map((item, idx) => (
                              <div key={idx} className="text-[10px] text-gray-600 truncate max-w-xs">
                                <strong className="text-gray-900">{item.quantity}x</strong> <span translate="no">{item.product.name}</span> 
                                {item.selectedSize && (
                                  <span className="text-[9px] text-gray-400 ml-1">({formatSizeLabel(item.selectedSize)})</span>
                                )}
                              </div>
                            ))}
                            {order.notes && (
                              <div className="text-[9px] font-black text-amber-700 bg-amber-50 px-1.5 py-0.5 rounded inline-block uppercase mt-1 truncate max-w-[200px]" title={order.notes}>
                                Obs: {order.notes}
                              </div>
                            )}
                            {order.deliveryFeePending && (
                              <div className="text-[9px] font-black text-amber-700 bg-amber-50 px-1.5 py-0.5 rounded inline-block uppercase mt-1">
                                ⚠️ Bairro novo — avaliar entrega
                              </div>
                            )}
                          </div>
                        </td>
                        <td className="p-3">
                          <span className="text-[10px] font-semibold bg-gray-100 px-2 py-0.5 rounded text-gray-700">
                            {paymentMap[order.paymentMethod || 'pix']}
                          </span>
                          {order.paymentMethod === 'cash' && order.changeRequested && (
                            <span className="text-[9px] text-gray-500 font-bold block mt-1 uppercase">
                              Troco para: {formatCurrency(order.changeFor || 0)}
                            </span>
                          )}
                        </td>
                        <td className="p-3">
                          <span className={`px-2 py-0.5 rounded text-[9px] font-black uppercase border tracking-wider ${statusColors[order.status]}`}>
                            {getAdminStatusLabel(order.status, order.serviceType)}
                          </span>
                        </td>
                        <td className="p-3 text-right pr-4 font-black text-gray-950">
                          {formatCurrency(order.total)}
                        </td>
                        <td className="p-3 text-center">
                          <Link 
                            to={`/admin/orders/${order.id}`}
                            className="inline-flex items-center gap-1 bg-brand text-white px-2 py-1 rounded text-[9px] font-black uppercase tracking-wider hover:bg-brand-dark transition-colors"
                          >
                            <Eye size={11} />
                            <span>Ver / Chat</span>
                          </Link>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}

      {/* TAB 3: ADVANCED SALES CRM & ANALYTICS */}
      {activeTab === 'crm' && (
        <div className="space-y-6">
          {/* CRM Period selector tabs */}
          <div className="bg-white p-3 border border-gray-200 rounded-xl shadow-sm flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
            <div>
              <h3 className="font-black text-xs text-gray-900 uppercase tracking-wider">CRM de Vendas & Relatório Comercial</h3>
              <p className="text-[9px] text-gray-400 font-bold uppercase tracking-widest mt-0.5">Analise o desempenho e a saúde financeira do restaurante</p>
            </div>
            <div className="flex flex-wrap gap-1">
              {[
                { id: 'yesterday', label: 'Ontem' },
                { id: 'day', label: 'Hoje' },
                { id: 'week', label: '7 Dias' },
                { id: 'month', label: '30 Dias' },
                { id: 'trimester', label: 'Trimestre' },
                { id: 'semester', label: 'Semestre' },
                { id: 'year', label: 'Ano' }
              ].map(tab => (
                <button
                  key={tab.id}
                  onClick={() => setCrmPeriod(tab.id as PeriodType)}
                  className={`px-3 py-1.5 text-[9px] font-black uppercase tracking-wider rounded border transition-colors ${
                    crmPeriod === tab.id
                      ? 'bg-brand text-white border-brand'
                      : 'bg-white border-gray-200 text-gray-500 hover:text-gray-900 hover:bg-gray-50'
                  }`}
                >
                  {tab.label}
                </button>
              ))}
            </div>
          </div>

          {/* Core Analytics Metrics Grid */}
          <div className="grid grid-cols-2 md:grid-cols-6 gap-3">
            <div className="bg-white p-4 rounded-xl border border-gray-100 shadow-sm border-l-4 border-l-green-500">
              <span className="text-[9px] text-gray-400 font-black uppercase tracking-widest block leading-none">Receita Total</span>
              <p className="text-sm md:text-lg font-black text-gray-900 mt-1.5">{formatCurrency(crmRevenue)}</p>
              <span className="text-[9px] text-green-600 font-semibold mt-1 inline-block uppercase">Pedidos finalizados</span>
            </div>

            <div className="bg-white p-4 rounded-xl border border-gray-100 shadow-sm border-l-4 border-l-red-500">
              <span className="text-[9px] text-gray-400 font-black uppercase tracking-widest block leading-none">Custo Fixo</span>
              <p className="text-sm md:text-lg font-black text-gray-900 mt-1.5">{formatCurrency(crmFixedCosts)}</p>
              <span className="text-[9px] text-red-500 font-semibold mt-1 inline-block uppercase">Histórico finances</span>
            </div>

            <div className="bg-white p-4 rounded-xl border border-gray-100 shadow-sm border-l-4 border-l-orange-500">
              <span className="text-[9px] text-gray-400 font-black uppercase tracking-widest block leading-none">Custo Variável</span>
              <p className="text-sm md:text-lg font-black text-gray-900 mt-1.5">{formatCurrency(crmVariableCosts)}</p>
              <span className="text-[9px] text-orange-500 font-semibold mt-1 inline-block uppercase">Ingredientes e outros</span>
            </div>

            <div className="bg-white p-4 rounded-xl border border-gray-100 shadow-sm border-l-4 border-l-blue-500">
              <span className="text-[9px] text-gray-400 font-black uppercase tracking-widest block leading-none">Lucro Líquido</span>
              <p className={`text-sm md:text-lg font-black mt-1.5 ${crmNetProfit >= 0 ? 'text-blue-600' : 'text-red-600'}`}>{formatCurrency(crmNetProfit)}</p>
              <span className="text-[9px] text-gray-400 font-semibold mt-1 inline-block uppercase">Margem de lucro</span>
            </div>

            <div className="bg-white p-4 rounded-xl border border-gray-100 shadow-sm border-l-4 border-l-indigo-500">
              <span className="text-[9px] text-gray-400 font-black uppercase tracking-widest block leading-none">Pedidos Pagos</span>
              <p className="text-sm md:text-lg font-black text-gray-900 mt-1.5">{crmCompletedCount}</p>
              <span className="text-[9px] text-indigo-500 font-semibold mt-1 inline-block uppercase">Cancelados: {crmCancelledCount}</span>
            </div>

            <div className="bg-white p-4 rounded-xl border border-gray-100 shadow-sm border-l-4 border-l-yellow-500">
              <span className="text-[9px] text-gray-400 font-black uppercase tracking-widest block leading-none">Ticket Médio</span>
              <p className="text-sm md:text-lg font-black text-gray-900 mt-1.5">{formatCurrency(crmAverageTicket)}</p>
              <span className="text-[9px] text-yellow-600 font-semibold mt-1 inline-block uppercase">Valor por compra</span>
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {/* Visual Comparative Chart */}
            <div className="bg-white p-5 rounded-xl border border-gray-200 shadow-sm flex flex-col">
              <h4 className="text-xs font-black text-gray-900 uppercase tracking-widest mb-4">Balancete de Receitas vs Despesas</h4>
              <div className="h-64 flex-1">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={rechartsCrmData}>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} />
                    <XAxis dataKey="name" stroke="#9ca3af" fontSize={10} fontWeight="bold" />
                    <YAxis stroke="#9ca3af" fontSize={10} />
                    <Tooltip formatter={(value: number) => formatCurrency(value)} />
                    <Bar dataKey="Valor" radius={[4, 4, 0, 0]} maxBarSize={60} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>

            {/* Top Products / Best Sellers */}
            <div className="bg-white p-5 rounded-xl border border-gray-200 shadow-sm flex flex-col">
              <h4 className="text-xs font-black text-gray-900 uppercase tracking-widest mb-4">Mais Vendidos do Período</h4>
              
              {topCrmProducts.length === 0 ? (
                <div className="flex-1 flex flex-col items-center justify-center text-xs text-gray-400 font-medium py-10">
                  <Utensils size={32} className="text-gray-300 mb-2" />
                  <p>Sem dados de produtos vendidos neste período.</p>
                </div>
              ) : (
                <div className="space-y-4 flex-1 justify-center flex flex-col">
                  {topCrmProducts.map((prod, idx) => {
                    const percentage = (prod.quantity / maxProductQuantity) * 100;
                    return (
                      <div key={idx} className="space-y-1">
                        <div className="flex justify-between items-center text-xs">
                          <span className="font-bold text-gray-800">{idx + 1}º <span translate="no">{prod.name}</span></span>
                          <span className="font-black text-gray-900">{prod.quantity} unidades <span className="text-[10px] text-gray-400">({formatCurrency(prod.revenue)})</span></span>
                        </div>
                        <div className="w-full bg-gray-100 h-2.5 rounded-full overflow-hidden">
                          <div 
                            className="bg-brand h-full rounded-full transition-all duration-500" 
                            style={{ width: `${percentage}%` }}
                          />
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>

          {/* Day-by-day revenue — only meaningful for the 7/30-day windows */}
          {dailyRevenueBreakdown.length > 0 && (
            <div className="bg-white p-5 rounded-xl border border-gray-200 shadow-sm">
              <h4 className="text-xs font-black text-gray-900 uppercase tracking-widest mb-4">Faturamento por Dia</h4>
              <div className="h-64">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={dailyRevenueBreakdown}>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} />
                    <XAxis
                      dataKey="label"
                      stroke="#9ca3af"
                      fontSize={9}
                      fontWeight="bold"
                      interval={crmPeriod === 'month' ? 3 : 0}
                    />
                    <YAxis stroke="#9ca3af" fontSize={10} />
                    <Tooltip formatter={(value: number) => formatCurrency(value)} />
                    <Bar dataKey="Faturamento" fill="#10b981" radius={[4, 4, 0, 0]} maxBarSize={40} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
          )}

          {/* Payment Methods Breakdowns */}
          <div className="bg-white p-5 rounded-xl border border-gray-200 shadow-sm">
            <h4 className="text-xs font-black text-gray-900 uppercase tracking-widest mb-4">Faturamento por Forma de Pagamento</h4>
            <div className="grid grid-cols-1 sm:grid-cols-4 gap-4">
              <div className="p-4 bg-yellow-50/50 rounded-xl border border-yellow-100 flex items-center gap-3">
                <div className="p-2 bg-yellow-100 text-yellow-700 rounded-lg">
                  <Landmark size={18} />
                </div>
                <div>
                  <span className="text-[9px] text-gray-400 font-black uppercase tracking-widest block">PIX</span>
                  <span className="text-sm font-black text-gray-900 block mt-0.5">{formatCurrency(paymentBreakdown.pix)}</span>
                </div>
              </div>

              <div className="p-4 bg-blue-50/50 rounded-xl border border-blue-100 flex items-center gap-3">
                <div className="p-2 bg-blue-100 text-blue-700 rounded-lg">
                  <DollarSign size={18} />
                </div>
                <div>
                  <span className="text-[9px] text-gray-400 font-black uppercase tracking-widest block">Crédito</span>
                  <span className="text-sm font-black text-gray-900 block mt-0.5">{formatCurrency(paymentBreakdown.credit)}</span>
                </div>
              </div>

              <div className="p-4 bg-purple-50/50 rounded-xl border border-purple-100 flex items-center gap-3">
                <div className="p-2 bg-purple-100 text-purple-700 rounded-lg">
                  <DollarSign size={18} />
                </div>
                <div>
                  <span className="text-[9px] text-gray-400 font-black uppercase tracking-widest block">Débito</span>
                  <span className="text-sm font-black text-gray-900 block mt-0.5">{formatCurrency(paymentBreakdown.debit)}</span>
                </div>
              </div>

              <div className="p-4 bg-green-50/50 rounded-xl border border-green-100 flex items-center gap-3">
                <div className="p-2 bg-green-100 text-green-700 rounded-lg">
                  <DollarSign size={18} />
                </div>
                <div>
                  <span className="text-[9px] text-gray-400 font-black uppercase tracking-widest block">Dinheiro</span>
                  <span className="text-sm font-black text-gray-900 block mt-0.5">{formatCurrency(paymentBreakdown.cash)}</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* TAB 5: USER MANAGEMENT / TEAM */}
      {activeTab === 'users' && (
        <div className="space-y-6">
          <div className="bg-white border border-gray-200 rounded-xl shadow-sm overflow-hidden">
            <div className="p-4 bg-gray-50/70 border-b border-gray-200 flex justify-between items-center">
              <div>
                <h3 className="font-black text-xs text-gray-900 uppercase tracking-widest flex items-center gap-2">
                  <ShieldAlert size={14} className="text-brand" /> Gerenciamento de Equipe
                </h3>
                <p className="text-[9px] text-gray-400 font-bold uppercase tracking-widest mt-0.5">Defina quem pode acessar o painel administrativo</p>
              </div>
              <span className="text-[10px] bg-brand/10 text-brand px-2 py-0.5 rounded font-black uppercase">
                {users.length} Usuários
              </span>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="border-b border-gray-200 bg-gray-50/40 text-[9px] font-black text-gray-400 uppercase tracking-widest">
                    <th className="p-4">Nome / E-mail</th>
                    <th className="p-4">Status de Acesso</th>
                    <th className="p-4">Pontos de Fidelidade</th>
                    <th className="p-4">Desde</th>
                    <th className="p-4 text-center">Ações</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100 text-xs font-medium text-gray-700">
                  {users.sort((a, b) => b.role === 'admin' ? 1 : -1).map(u => (
                    <tr key={u.id} className="hover:bg-gray-50/60 transition-colors">
                      <td className="p-4">
                        <div className="flex items-center gap-3">
                          <div className={`w-8 h-8 rounded-full flex items-center justify-center font-black text-xs ${u.role === 'admin' ? 'bg-brand text-white' : 'bg-gray-100 text-gray-400'}`}>
                            {u.name?.charAt(0).toUpperCase()}
                          </div>
                          <div>
                            <span className="font-bold text-gray-900 block">{u.name}</span>
                            <span className="text-[10px] text-gray-400 font-semibold">{u.email || u.phone || '—'}</span>
                          </div>
                        </div>
                      </td>
                      <td className="p-4">
                        <span className={`px-2 py-0.5 rounded text-[9px] font-black uppercase border tracking-wider ${
                          u.role === 'admin' 
                            ? 'bg-purple-100 text-purple-800 border-purple-200' 
                            : 'bg-gray-100 text-gray-600 border-gray-200'
                        }`}>
                          {u.role === 'admin' ? 'Administrador' : 'Cliente / Usuário'}
                        </span>
                      </td>
                      <td className="p-4">
                        <div className="flex items-center gap-2">
                          <span className="font-black text-amber-700 flex items-center gap-1 text-xs">
                            <Star size={12} className="fill-amber-500 text-amber-500" /> {u.points || 0}
                          </span>
                          <button
                            onClick={async () => {
                              const input = window.prompt(`Quantos pontos deseja adicionar para ${u.name}? (use um número negativo para remover)`, '10');
                              if (input === null) return;
                              const amount = parseInt(input, 10);
                              if (!amount || isNaN(amount)) return;
                              try {
                                await setDoc(doc(db, 'users', u.id), { points: increment(amount) }, { merge: true });
                              } catch (err) {
                                handleFirestoreError(err, OperationType.UPDATE, `users/${u.id}`);
                              }
                            }}
                            className="p-1 text-brand hover:bg-brand/10 rounded transition-colors"
                            title="Adicionar ou remover pontos manualmente"
                          >
                            <Plus size={12} />
                          </button>
                        </div>
                      </td>
                      <td className="p-4 text-gray-400 text-[10px]">
                        {u.createdAt ? format(new Date(u.createdAt), 'dd/MM/yyyy') : 'N/A'}
                      </td>
                      <td className="p-4 text-center">
                        <div className="flex items-center justify-center gap-2">
                          <button
                            onClick={() => { setViewingUser(u); setFixLocationMessage(null); }}
                            className="inline-flex items-center gap-1 px-3 py-1.5 rounded text-[10px] font-black uppercase tracking-wider transition-colors bg-gray-100 text-gray-600 hover:bg-gray-200"
                            title="Ver dados de cadastro (telefone, endereço, localização)"
                          >
                            <Eye size={12} /> Ver Dados
                          </button>
                          {isBillingAdminEmail(u.email) ? (
                            <span
                              title="Admin protegido — não pode ser rebaixado"
                              className="inline-flex items-center gap-1 px-3 py-1.5 rounded text-[10px] font-black uppercase tracking-wider bg-gray-100 text-gray-400 cursor-not-allowed"
                            >
                              <Lock size={12} /> Admin Protegido
                            </span>
                          ) : (
                            <button
                              onClick={async () => {
                                const newRole = u.role === 'admin' ? 'user' : 'admin';
                                if (window.confirm(`Deseja alterar o cargo de ${u.name} para ${newRole}?`)) {
                                  try {
                                    await setDoc(doc(db, 'users', u.id), { role: newRole }, { merge: true });
                                  } catch (err) {
                                    handleFirestoreError(err, OperationType.UPDATE, `users/${u.id}`);
                                  }
                                }
                              }}
                              className={`inline-flex items-center gap-1 px-3 py-1.5 rounded text-[10px] font-black uppercase tracking-wider transition-colors ${
                                u.role === 'admin'
                                  ? 'bg-red-50 text-red-600 hover:bg-red-100'
                                  : 'bg-brand text-white hover:bg-brand-dark'
                              }`}
                            >
                              {u.role === 'admin' ? <TrendingDown size={12} /> : <TrendingUp size={12} />}
                              {u.role === 'admin' ? 'Remover Admin' : 'Tornar Admin'}
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
          
          <div className="bg-amber-50 border border-amber-100 p-4 rounded-xl flex gap-3 items-start">
            <ShieldAlert size={20} className="text-amber-600 flex-shrink-0 mt-0.5" />
            <div>
              <p className="text-xs font-black text-amber-900 uppercase tracking-tight">Dica de Segurança</p>
              <p className="text-[10px] text-amber-800 font-semibold mt-1 leading-relaxed">
                Administradores têm acesso total ao faturamento, histórico de clientes e configurações da empresa. 
                Certifique-se de conceder este acesso apenas a pessoas de confiança da sua equipe.
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Client registration data modal — lets the admin see phone/address/
          geolocation directly, e.g. to diagnose a wrong "fora da área de
          entrega" report instead of guessing blind. */}
      {viewingUser && (() => {
        const u = viewingUser;
        const addressLines = [
          u.addressStreet && `${u.addressStreet}${u.addressNumber ? `, Nº ${u.addressNumber}` : ''}`,
          u.addressComplement,
          u.addressNeighborhood,
          u.addressCity && `${u.addressCity}${u.addressState ? `/${u.addressState.toUpperCase()}` : ''}`,
          u.addressZip && `CEP: ${u.addressZip}`,
          u.addressReference && `Ref: ${u.addressReference}`,
        ].filter(Boolean);

        const distanceFromStoreKm = (u.lat && u.lng && companyInfo.lat && companyInfo.lng)
          ? calculateDistance(companyInfo.lat, companyInfo.lng, u.lat, u.lng) / 1000
          : null;
        const geocodeLooksWrong = distanceFromStoreKm !== null && distanceFromStoreKm > 200;

        return (
          <div className="fixed inset-0 z-[80] bg-black/50 backdrop-blur-sm flex items-center justify-center p-4" onClick={() => { setViewingUser(null); setFixLocationMessage(null); }}>
            <div className="bg-white rounded-2xl shadow-2xl max-w-md w-full max-h-[85vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
              <div className="p-5 border-b border-gray-100 flex items-center justify-between sticky top-0 bg-white">
                <div>
                  <h3 className="text-sm font-black text-gray-900 uppercase tracking-wider">{u.name}</h3>
                  <p className="text-[10px] text-gray-400 font-bold">{u.email}</p>
                </div>
                <button onClick={() => { setViewingUser(null); setFixLocationMessage(null); }} className="p-1.5 text-gray-400 hover:bg-gray-100 rounded-full">
                  <X size={16} />
                </button>
              </div>

              <div className="p-5 space-y-4">
                <div>
                  <p className="text-[9px] font-black text-gray-400 uppercase tracking-widest mb-1">Telefone / WhatsApp</p>
                  <p className="text-xs font-bold text-gray-800">{u.phone || 'Não informado'}</p>
                </div>

                <div>
                  <p className="text-[9px] font-black text-gray-400 uppercase tracking-widest mb-1">Endereço cadastrado</p>
                  {addressLines.length > 0 ? (
                    <p className="text-xs font-bold text-gray-800 leading-relaxed">{addressLines.join(' — ')}</p>
                  ) : (
                    <p className="text-xs text-gray-400 font-bold">Não informado</p>
                  )}
                </div>

                <div>
                  <div className="flex items-center justify-between mb-1">
                    <p className="text-[9px] font-black text-gray-400 uppercase tracking-widest">Localização (usada para calcular o raio de entrega)</p>
                    <button
                      onClick={() => handleFixUserLocation(u)}
                      disabled={fixingLocation}
                      className="text-[9px] font-black text-brand hover:underline uppercase tracking-wider disabled:opacity-50 disabled:no-underline flex items-center gap-1"
                    >
                      {fixingLocation ? <RefreshCw size={10} className="animate-spin" /> : <RefreshCw size={10} />}
                      {fixingLocation ? 'Recalculando...' : 'Recalcular localização'}
                    </button>
                  </div>
                  {u.lat && u.lng ? (
                    <div className="flex items-center gap-2">
                      <p className="text-xs font-bold text-gray-800">{u.lat.toFixed(5)}, {u.lng.toFixed(5)}</p>
                      <a
                        href={`https://www.google.com/maps?q=${u.lat},${u.lng}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-[10px] font-black text-brand hover:underline uppercase tracking-wider"
                      >
                        Ver no mapa
                      </a>
                    </div>
                  ) : (
                    <p className="text-xs text-gray-400 font-bold">Ainda não calculada (o cliente nunca finalizou um pedido de delivery, ou o endereço não tem CEP/rua completos)</p>
                  )}
                  {fixLocationMessage && (
                    <p className="text-[10px] font-bold mt-1.5 text-gray-600">{fixLocationMessage}</p>
                  )}
                </div>

                {distanceFromStoreKm !== null && (
                  <div className={`rounded-lg p-3 border ${geocodeLooksWrong ? 'bg-red-50 border-red-200' : 'bg-emerald-50 border-emerald-200'}`}>
                    <p className={`text-[10px] font-black uppercase tracking-widest mb-1 ${geocodeLooksWrong ? 'text-red-700' : 'text-emerald-700'}`}>
                      {geocodeLooksWrong ? '⚠️ Localização provavelmente errada' : 'Distância até o estabelecimento'}
                    </p>
                    <p className={`text-xs font-bold ${geocodeLooksWrong ? 'text-red-800' : 'text-emerald-800'}`}>
                      {distanceFromStoreKm.toFixed(1)} km
                    </p>
                    {geocodeLooksWrong && (
                      <>
                        <p className="text-[10px] text-red-700 font-semibold mt-1.5 leading-relaxed">
                          Uma distância tão grande normalmente significa que o serviço gratuito de mapas (Nominatim) confundiu o endereço com um lugar de nome parecido em outra cidade — não que o cliente está mesmo fora da área.
                        </p>
                        <button
                          onClick={() => handleFixUserLocation(u)}
                          disabled={fixingLocation}
                          className="mt-2 w-full bg-red-600 text-white text-[10px] font-black uppercase tracking-widest py-2 rounded-lg hover:bg-red-700 transition-colors disabled:opacity-50 flex items-center justify-center gap-1.5"
                        >
                          {fixingLocation ? <RefreshCw size={12} className="animate-spin" /> : <RefreshCw size={12} />}
                          {fixingLocation ? 'Corrigindo...' : 'Corrigir localização agora'}
                        </button>
                      </>
                    )}
                  </div>
                )}

                <div className="pt-3 border-t border-gray-100 flex items-center justify-between text-[10px] text-gray-400 font-bold uppercase tracking-wider">
                  <span>Pontos de fidelidade: {u.points || 0}</span>
                  <span>Cadastro: {u.createdAt ? format(new Date(u.createdAt), 'dd/MM/yyyy') : 'N/A'}</span>
                </div>
              </div>
            </div>
          </div>
        );
      })()}

      {/* TAB: BILLING / CENTRAL DE COBRANÇA — Michel & Rafael only */}
      {activeTab === 'billing' && isBillingAdmin && (
        <div className="space-y-6">
          <div className="bg-white border border-gray-200 rounded-xl shadow-sm p-5">
            <h3 className="font-black text-xs text-gray-900 uppercase tracking-widest flex items-center gap-2 mb-4">
              <CreditCard size={14} className="text-brand" /> Status da Cobrança
            </h3>
            {billing ? (
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 text-xs">
                <div className="bg-gray-50 rounded-lg p-3 border border-gray-100">
                  <p className="text-[9px] font-black text-gray-400 uppercase tracking-widest mb-1">Taxa de Lançamento ({formatCurrency(billing.launchFeeAmount)})</p>
                  <p className={`font-black ${billing.launchFeePaid ? 'text-green-700' : 'text-red-600'}`}>
                    {billing.launchFeePaid ? 'PAGA' : 'PENDENTE'}
                  </p>
                </div>
                <div className="bg-gray-50 rounded-lg p-3 border border-gray-100">
                  <p className="text-[9px] font-black text-gray-400 uppercase tracking-widest mb-1">Mensalidade ({formatCurrency(billing.monthlyFeeAmount)})</p>
                  <p className="font-black text-gray-800">
                    {billing.nextDueDate ? `Vence em ${format(billing.nextDueDate, 'dd/MM/yyyy')}` : 'Vencimento não definido'}
                  </p>
                </div>
                <div className="bg-gray-50 rounded-lg p-3 border border-gray-100">
                  <p className="text-[9px] font-black text-gray-400 uppercase tracking-widest mb-1">Último pagamento confirmado</p>
                  <p className="font-black text-gray-800">
                    {billing.lastConfirmedPaymentAt ? format(billing.lastConfirmedPaymentAt, 'dd/MM/yyyy HH:mm') : '—'}
                  </p>
                </div>
              </div>
            ) : (
              <p className="text-xs text-gray-400 font-bold">Carregando...</p>
            )}
            {!billing?.launchFeePaid && (
              <button
                onClick={handleConfirmLaunchFee}
                disabled={confirmingProofId === 'launch'}
                className="mt-4 bg-brand text-white px-4 py-2 rounded-lg text-[10px] font-black uppercase tracking-widest hover:bg-brand-dark disabled:opacity-50"
              >
                {confirmingProofId === 'launch' ? 'Confirmando...' : 'Confirmar Taxa de Lançamento Recebida'}
              </button>
            )}
          </div>

          <div className="bg-white border border-gray-200 rounded-xl shadow-sm overflow-hidden">
            <div className="p-4 bg-gray-50/70 border-b border-gray-200">
              <h3 className="font-black text-xs text-gray-900 uppercase tracking-widest flex items-center gap-2">
                <Lock size={14} className="text-brand" /> Comprovantes e Solicitações Recebidas
              </h3>
              <p className="text-[9px] text-gray-400 font-bold uppercase tracking-widest mt-0.5">Caixa exclusiva — visível apenas para Michel e Rafael</p>
            </div>
            <div className="divide-y divide-gray-100">
              {billingProofs.length === 0 && (
                <div className="text-center py-8">
                  <p className="text-[10px] font-bold text-gray-400 uppercase tracking-widest">Nenhum comprovante enviado ainda</p>
                </div>
              )}
              {billingProofs.map(proof => (
                <div key={proof.id} className="p-4 flex flex-col sm:flex-row sm:items-center gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-bold text-xs text-gray-900">{proof.senderName}</span>
                      <span className="text-[9px] text-gray-400 font-semibold">{proof.senderEmail}</span>
                      <span className={`px-1.5 py-0.5 rounded text-[9px] font-black uppercase border ${
                        proof.status === 'confirmed'
                          ? 'bg-green-100 text-green-700 border-green-200'
                          : 'bg-amber-100 text-amber-700 border-amber-200'
                      }`}>
                        {proof.status === 'confirmed' ? 'Confirmado' : 'Pendente'}
                      </span>
                      <span className="text-[9px] text-gray-400 font-bold uppercase">
                        {proof.type === 'launch_fee' ? 'Taxa de Lançamento' : proof.type === 'monthly' ? 'Mensalidade' : 'Proposta de Vencimento'}
                      </span>
                    </div>
                    {proof.note && <p className="text-[11px] text-gray-600 font-medium mt-1">{proof.note}</p>}
                    {proof.requestedDueDate && (
                      <p className="text-[11px] text-gray-600 font-bold mt-1">Data proposta: {format(proof.requestedDueDate, 'dd/MM/yyyy')}</p>
                    )}
                    {proof.imageUrl && (
                      <a href={proof.imageUrl} target="_blank" rel="noopener noreferrer" className="inline-block mt-2">
                        <img src={proof.imageUrl} alt="Comprovante" className="h-20 rounded-lg border border-gray-200 object-cover" />
                      </a>
                    )}
                    <p className="text-[9px] text-gray-400 font-bold mt-1 uppercase tracking-wider">
                      {format(proof.createdAt, 'dd/MM/yyyy HH:mm')}
                    </p>
                  </div>
                  {proof.status === 'pending' && (
                    <div className="shrink-0">
                      {proof.type === 'launch_fee' && (
                        <button
                          onClick={handleConfirmLaunchFee}
                          disabled={confirmingProofId === 'launch'}
                          className="bg-brand text-white px-3 py-1.5 rounded-lg text-[10px] font-black uppercase tracking-widest hover:bg-brand-dark disabled:opacity-50"
                        >
                          Confirmar Pagamento
                        </button>
                      )}
                      {proof.type === 'set_due_date' && proof.requestedDueDate && (
                        <button
                          onClick={() => handleConfirmDueDate(proof.requestedDueDate!, proof.id)}
                          disabled={confirmingProofId === proof.id}
                          className="bg-brand text-white px-3 py-1.5 rounded-lg text-[10px] font-black uppercase tracking-widest hover:bg-brand-dark disabled:opacity-50"
                        >
                          Confirmar Vencimento
                        </button>
                      )}
                      {proof.type === 'monthly' && (
                        <button
                          onClick={() => handleConfirmMonthlyPayment(proof.id)}
                          disabled={confirmingProofId === proof.id}
                          className="bg-brand text-white px-3 py-1.5 rounded-lg text-[10px] font-black uppercase tracking-widest hover:bg-brand-dark disabled:opacity-50"
                        >
                          Confirmar Mensalidade
                        </button>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* TAB 4: COMPANY DETAILS / CONFIGURATIONS */}
      {activeTab === 'settings' && (
        <div className="bg-white border border-gray-200 rounded-xl shadow-sm overflow-hidden">
          <div className="p-4 bg-gray-50/70 border-b border-gray-200 flex justify-between items-center">
            <div>
              <h3 className="font-black text-xs text-gray-900 uppercase tracking-widest flex items-center gap-2">
                <Settings size={14} className="text-brand" /> Dados do Estabelecimento
              </h3>
              <p className="text-[9px] text-gray-400 font-bold uppercase tracking-widest mt-0.5">Gerencie os dados públicos exibidos aos clientes nas telas de pedido, chat e comprovantes</p>
            </div>
            <button
              onClick={() => handleSaveSettings()}
              disabled={savingSettings}
              className="bg-brand text-white text-[10px] font-black uppercase tracking-widest px-4 py-2 rounded-lg hover:bg-brand-dark flex items-center gap-2 transition-colors disabled:opacity-50 shadow-sm"
            >
              {savingSettings ? <RefreshCw size={12} className="animate-spin" /> : <Save size={12} />}
              <span>Salvar Alterações</span>
            </button>
          </div>

          <form onSubmit={handleSaveSettings} className="p-6 space-y-4">
            {settingsSavedSuccess && (
              <div className="bg-green-50 border border-green-200 p-3 rounded-lg text-green-800 text-xs font-bold uppercase tracking-wider flex items-center gap-2 animate-fade-in">
                <Check size={16} />
                <span>Configurações salvas e publicadas com sucesso!</span>
              </div>
            )}

            {/* Logo do App / Estabelecimento */}
            <div className="bg-gray-50 border border-gray-150 p-4 rounded-xl space-y-3">
              <label className="block text-[9px] font-black text-gray-500 uppercase tracking-widest">Logomarca do Estabelecimento (Logo do App)</label>
              
              <div className="flex flex-col sm:flex-row items-center gap-4">
                <div className="w-20 h-20 rounded-full border border-gray-200 bg-white overflow-hidden flex items-center justify-center relative shadow-inner shrink-0">
                  {companyInfo.logoUrl && !logoError ? (
                    <img src={companyInfo.logoUrl} onError={() => setLogoError(true)} alt="Logo" className="w-full h-full object-cover" />
                  ) : (
                    <div className="text-gray-300 flex flex-col items-center">
                      <ImageIcon size={32} />
                    </div>
                  )}
                  {uploadingLogo && (
                    <div className="absolute inset-0 bg-white/80 flex items-center justify-center">
                      <div className="w-6 h-6 border-2 border-brand border-t-transparent rounded-full animate-spin" />
                    </div>
                  )}
                </div>

                <div className="space-y-1.5 flex-1 text-center sm:text-left">
                  <p className="text-[10px] font-bold text-gray-600">Personalize a identidade visual do seu app.</p>
                  <p className="text-[9px] text-gray-400">Envie uma imagem quadrada (PNG ou JPEG) para ser exibida nos cabeçalhos, checkout e telas do cliente.</p>
                  
                  <div className="flex flex-wrap gap-2 justify-center sm:justify-start pt-1">
                    <input 
                      type="file" 
                      ref={logoInputRef}
                      onChange={handleLogoChange}
                      accept="image/*"
                      className="hidden"
                    />
                    <button
                      type="button"
                      disabled={uploadingLogo}
                      onClick={() => logoInputRef.current?.click()}
                      className="inline-flex items-center gap-1 px-3 py-1.5 bg-brand text-white text-[10px] font-bold uppercase tracking-wider rounded hover:bg-brand-dark transition-all disabled:opacity-50"
                    >
                      <Upload size={12} />
                      {uploadingLogo ? 'Enviando...' : 'Fazer Upload'}
                    </button>
                    
                    {companyInfo.logoUrl && (
                      <button
                        type="button"
                        onClick={handleRemoveLogo}
                        className="inline-flex items-center gap-1 px-3 py-1.5 bg-red-50 text-red-600 border border-red-200 text-[10px] font-bold uppercase tracking-wider rounded hover:bg-red-100 hover:border-red-300 transition-all"
                      >
                        <Trash2 size={12} />
                        Remover Logo
                      </button>
                    )}

                    <button
                      type="button"
                      disabled={savingSettings || uploadingLogo}
                      onClick={() => handleSaveSettings()}
                      className="inline-flex items-center gap-1 px-3 py-1.5 bg-green-600 text-white text-[10px] font-bold uppercase tracking-wider rounded hover:bg-green-700 transition-all disabled:opacity-50 shadow-sm"
                    >
                      <Check size={12} />
                      {savingSettings ? 'Salvando...' : 'Aplicar Alterações'}
                    </button>
                  </div>
                </div>
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-[9px] font-black text-gray-400 uppercase tracking-widest mb-1.5">Nome do Estabelecimento</label>
                <input
                  type="text"
                  required
                  value={companyInfo.name}
                  onChange={e => setCompanyInfo({ ...companyInfo, name: e.target.value })}
                  placeholder="Ex: SENSAÇÃO GOUMERT Restaurante"
                  className="w-full border border-gray-200 bg-gray-50 rounded-lg py-2 px-3 text-xs font-bold text-gray-800 focus:ring-brand focus:border-brand"
                />
              </div>

              <div>
                <label className="block text-[9px] font-black text-gray-400 uppercase tracking-widest mb-1.5">Telefone / WhatsApp de Contato</label>
                <input
                  type="text"
                  required
                  value={companyInfo.phone}
                  onChange={e => setCompanyInfo({ ...companyInfo, phone: e.target.value })}
                  placeholder="Ex: 21 99999-9999"
                  className="w-full border border-gray-200 bg-gray-50 rounded-lg py-2 px-3 text-xs font-bold text-gray-800 focus:ring-brand focus:border-brand"
                />
              </div>
            </div>

            <div className="space-y-4">
              <label className="block text-[11px] font-black text-gray-800 uppercase tracking-widest mb-2 border-b border-gray-100 pb-1">Endereço do Estabelecimento</label>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <div>
                  <label className="block text-[9px] font-black text-gray-400 uppercase tracking-widest mb-1.5">CEP</label>
                  <div className="flex gap-2">
                    <input
                      type="text"
                      required
                      value={companyInfo.addressZip || ''}
                      onChange={handleCompanyCepChange}
                      placeholder="Ex: 25570-162"
                      className="w-full border border-gray-200 bg-gray-50 rounded-lg py-2 px-3 text-xs font-bold text-gray-800 focus:ring-brand focus:border-brand"
                    />
                    <button
                      type="button"
                      onClick={() => {
                        const digits = (companyInfo.addressZip || '').replace(/\D/g, '');
                        if (digits.length === 8) {
                          lookupCompanyCEP(digits);
                        } else {
                          setCepStatus({ type: 'error', message: 'Digite um CEP com 8 números.' });
                        }
                      }}
                      disabled={cepLoading}
                      className="bg-brand hover:bg-brand/90 text-white px-3 py-2 rounded-lg text-[10px] font-black uppercase tracking-widest shrink-0 transition-all flex items-center gap-1 cursor-pointer disabled:opacity-50"
                    >
                      {cepLoading ? <Loader2 size={12} className="animate-spin" /> : <Search size={12} />}
                      <span>Buscar</span>
                    </button>
                  </div>
                  {cepStatus.message && (
                    <p className={`text-[10px] font-bold mt-1.5 flex items-center gap-1 ${
                      cepStatus.type === 'error' ? 'text-red-500' :
                      cepStatus.type === 'success' ? 'text-green-600' :
                      'text-brand animate-pulse'
                    }`}>
                      {cepStatus.type === 'error' && <AlertCircle size={12} />}
                      {cepStatus.type === 'success' && <CheckCircle2 size={12} />}
                      {cepStatus.type === 'loading' && <Loader2 size={12} className="animate-spin" />}
                      <span>{cepStatus.message}</span>
                    </p>
                  )}
                </div>
                <div className="sm:col-span-2">
                  <label className="block text-[9px] font-black text-gray-400 uppercase tracking-widest mb-1.5">Rua / Logradouro</label>
                  <input
                    type="text"
                    required
                    value={companyInfo.addressStreet || ''}
                    onChange={e => setCompanyInfo({ ...companyInfo, addressStreet: e.target.value })}
                    placeholder="Ex: Av. Euclídes da Cunha"
                    className="w-full border border-gray-200 bg-gray-50 rounded-lg py-2 px-3 text-xs font-bold text-gray-800 focus:ring-brand focus:border-brand"
                  />
                </div>
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                <div>
                  <label className="block text-[9px] font-black text-gray-400 uppercase tracking-widest mb-1.5">Número</label>
                  <input
                    type="text"
                    required
                    value={companyInfo.addressNumber || ''}
                    onChange={e => setCompanyInfo({ ...companyInfo, addressNumber: e.target.value })}
                    placeholder="Ex: 800"
                    className="w-full border border-gray-200 bg-gray-50 rounded-lg py-2 px-3 text-xs font-bold text-gray-800 focus:ring-brand focus:border-brand"
                  />
                </div>
                <div>
                  <label className="block text-[9px] font-black text-gray-400 uppercase tracking-widest mb-1.5">Complemento</label>
                  <input
                    type="text"
                    value={companyInfo.addressComplement || ''}
                    onChange={e => setCompanyInfo({ ...companyInfo, addressComplement: e.target.value })}
                    placeholder="Ex: Loja 1"
                    className="w-full border border-gray-200 bg-gray-50 rounded-lg py-2 px-3 text-xs font-bold text-gray-800 focus:ring-brand focus:border-brand"
                  />
                </div>
                <div className="col-span-2 sm:col-span-2">
                  <label className="block text-[9px] font-black text-gray-400 uppercase tracking-widest mb-1.5">Bairro</label>
                  <input
                    type="text"
                    required
                    value={companyInfo.addressNeighborhood || ''}
                    onChange={e => setCompanyInfo({ ...companyInfo, addressNeighborhood: e.target.value })}
                    placeholder="Ex: Vila São João"
                    className="w-full border border-gray-200 bg-gray-50 rounded-lg py-2 px-3 text-xs font-bold text-gray-800 focus:ring-brand focus:border-brand"
                  />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-[9px] font-black text-gray-400 uppercase tracking-widest mb-1.5">Cidade</label>
                  <input
                    type="text"
                    required
                    value={companyInfo.addressCity || ''}
                    onChange={e => setCompanyInfo({ ...companyInfo, addressCity: e.target.value })}
                    placeholder="Ex: São João de Meriti"
                    className="w-full border border-gray-200 bg-gray-50 rounded-lg py-2 px-3 text-xs font-bold text-gray-800 focus:ring-brand focus:border-brand"
                  />
                </div>
                <div>
                  <label className="block text-[9px] font-black text-gray-400 uppercase tracking-widest mb-1.5">Estado</label>
                  <input
                    type="text"
                    required
                    value={companyInfo.addressState || ''}
                    onChange={e => setCompanyInfo({ ...companyInfo, addressState: e.target.value })}
                    placeholder="Ex: RJ"
                    className="w-full border border-gray-200 bg-gray-50 rounded-lg py-2 px-3 text-xs font-bold text-gray-800 focus:ring-brand focus:border-brand"
                  />
                </div>
              </div>
            </div>
            
            <div className="border-t border-gray-100 pt-4 mt-4">
              <label className="block text-[9px] font-black text-gray-400 uppercase tracking-widest mb-1.5">Instagram do Estabelecimento</label>
              <input
                type="url"
                value={companyInfo.instagramUrl || ''}
                onChange={e => setCompanyInfo({ ...companyInfo, instagramUrl: e.target.value })}
                placeholder="Ex: https://www.instagram.com/sensacaogourmetofc"
                className="w-full border border-gray-200 bg-gray-50 rounded-lg py-2 px-3 text-xs font-bold text-gray-800 focus:ring-brand focus:border-brand"
              />
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 border-t border-gray-100 pt-4">
              <div>
                <label className="block text-[9px] font-black text-gray-400 uppercase tracking-widest mb-1.5">Chave PIX do Estabelecimento</label>
                <input
                  type="text"
                  required
                  value={companyInfo.pixKey}
                  onChange={e => setCompanyInfo({ ...companyInfo, pixKey: e.target.value })}
                  placeholder="Chave CNPJ, Celular, E-mail, CPF, etc..."
                  className="w-full border border-gray-200 bg-gray-50 rounded-lg py-2 px-3 text-xs font-bold text-gray-800 focus:ring-brand focus:border-brand"
                />
              </div>

              <div>
                <label className="block text-[9px] font-black text-gray-400 uppercase tracking-widest mb-1.5">Nome do Beneficiário / Razão Social</label>
                <input
                  type="text"
                  required
                  value={companyInfo.pixKeyName}
                  onChange={e => setCompanyInfo({ ...companyInfo, pixKeyName: e.target.value })}
                  placeholder="Ex: SENSAÇÃO GOUMERT de Meriti Ltda"
                  className="w-full border border-gray-200 bg-gray-50 rounded-lg py-2 px-3 text-xs font-bold text-gray-800 focus:ring-brand focus:border-brand"
                />
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 border-t border-gray-100 pt-4">
              <div>
                <label className="block text-[9px] font-black text-gray-400 uppercase tracking-widest mb-1.5">Raio de Entrega (Metros)</label>
                <input
                  type="number"
                  min="0"
                  step="100"
                  value={companyInfo.deliveryRadiusKm ? companyInfo.deliveryRadiusKm * 1000 : ''}
                  onChange={e => setCompanyInfo({ ...companyInfo, deliveryRadiusKm: e.target.value ? Number(e.target.value) / 1000 : 0 })}
                  placeholder="Ex: 2500"
                  className="w-full border border-gray-200 bg-gray-50 rounded-lg py-2 px-3 text-xs font-bold text-gray-800 focus:ring-brand focus:border-brand"
                />
              </div>

              <div>
                <label className="block text-[9px] font-black text-gray-400 uppercase tracking-widest mb-1.5">Taxa de Entrega (R$)</label>
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={companyInfo.deliveryFee ?? ''}
                  onChange={e => setCompanyInfo({ ...companyInfo, deliveryFee: e.target.value ? Number(e.target.value) : 0 })}
                  placeholder="Ex: 5.00"
                  className="w-full border border-gray-200 bg-gray-50 rounded-lg py-2 px-3 text-xs font-bold text-gray-800 focus:ring-brand focus:border-brand"
                />
              </div>

              <div>
                <label className="block text-[9px] font-black text-gray-400 uppercase tracking-widest mb-1.5">Tempo Estimado de Preparo</label>
                <input
                  type="text"
                  value={companyInfo.prepTimeEstimate || ''}
                  onChange={e => setCompanyInfo({ ...companyInfo, prepTimeEstimate: e.target.value })}
                  placeholder="Ex: Até 30 Minutos"
                  className="w-full border border-gray-200 bg-gray-50 rounded-lg py-2 px-3 text-xs font-bold text-gray-800 focus:ring-brand focus:border-brand"
                />
              </div>

              <div>
                <label className="block text-[9px] font-black text-gray-400 uppercase tracking-widest mb-1.5">Tempo Estimado de Entrega</label>
                <input
                  type="text"
                  value={companyInfo.deliveryTimeEstimate || ''}
                  onChange={e => setCompanyInfo({ ...companyInfo, deliveryTimeEstimate: e.target.value })}
                  placeholder="Ex: 30 - 60min."
                  className="w-full border border-gray-200 bg-gray-50 rounded-lg py-2 px-3 text-xs font-bold text-gray-800 focus:ring-brand focus:border-brand"
                />
              </div>
            </div>

            {/* NEIGHBORHOOD DELIVERY FEES */}
            <div className="border-t border-gray-100 pt-6 mt-6">
              <div className="flex justify-between items-center mb-3">
                <h4 className="text-[10px] font-black text-gray-500 uppercase tracking-widest">Taxas de Entrega por Bairro</h4>
                <button
                  type="button"
                  onClick={() => {
                    const currentFees = companyInfo.neighborhoodFees || [];
                    setCompanyInfo({
                      ...companyInfo,
                      neighborhoodFees: [...currentFees, { name: '', fee: 0 }]
                    });
                  }}
                  className="bg-brand/10 text-brand px-2 py-1 rounded text-[9px] font-bold uppercase tracking-widest hover:bg-brand/20 transition-colors"
                >
                  + Adicionar Bairro
                </button>
              </div>
              <p className="text-[10px] text-gray-400 font-bold uppercase tracking-wider mb-4">Caso o cliente preencha um bairro listado aqui, a taxa de entrega dele será definida automaticamente com o valor correspondente.</p>

              <div className="relative mb-3">
                <Search size={12} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
                <input
                  type="text"
                  placeholder="Buscar bairro já cadastrado na lista abaixo..."
                  value={neighborhoodFilterQuery}
                  onChange={e => setNeighborhoodFilterQuery(e.target.value)}
                  className="w-full pl-8 pr-3 py-2 border border-gray-200 bg-white rounded-lg text-[10px] font-bold text-gray-800 focus:outline-none focus:ring-2 focus:ring-brand/20 focus:border-brand"
                />
              </div>

              <div className="space-y-2 max-h-60 overflow-y-auto pr-2">
                {(companyInfo.neighborhoodFees || [])
                  .map((nh, idx) => ({ nh, idx }))
                  .filter(({ nh }) => !neighborhoodFilterQuery.trim() || normalizeText(nh.name || '').includes(normalizeText(neighborhoodFilterQuery)))
                  .map(({ nh, idx }) => {
                  const suggestions = neighborhoodSuggestIdx === idx
                    ? (() => {
                        const q = normalizeText(nh.name || '');
                        return knownNeighborhoods
                          .filter(n => !q || normalizeText(n).includes(q))
                          .slice(0, 8);
                      })()
                    : [];
                  return (
                  <div key={idx} className="flex items-center gap-2 bg-gray-50 p-2 rounded-lg border border-gray-100">
                    <div className="flex-1 relative">
                    <input
                      type="text"
                      placeholder="Buscar/digitar nome do bairro"
                      value={nh.name}
                      onFocus={() => setNeighborhoodSuggestIdx(idx)}
                      onBlur={() => setTimeout(() => setNeighborhoodSuggestIdx(prev => prev === idx ? null : prev), 150)}
                      onChange={(e) => {
                        const newFees = [...(companyInfo.neighborhoodFees || [])];
                        newFees[idx].name = e.target.value;
                        setCompanyInfo({ ...companyInfo, neighborhoodFees: newFees });
                        setNeighborhoodSuggestIdx(idx);
                      }}
                      className="w-full bg-white border border-gray-200 rounded py-1.5 px-2 text-[10px] font-bold text-gray-800 focus:ring-brand focus:border-brand"
                    />
                    {suggestions.length > 0 && (
                      <div className="absolute z-20 top-full left-0 right-0 mt-1 bg-white border border-gray-200 rounded-lg shadow-lg max-h-40 overflow-y-auto">
                        {suggestions.map(s => (
                          <button
                            type="button"
                            key={s}
                            onMouseDown={(e) => e.preventDefault()}
                            onClick={() => {
                              const newFees = [...(companyInfo.neighborhoodFees || [])];
                              newFees[idx].name = s;
                              setCompanyInfo({ ...companyInfo, neighborhoodFees: newFees });
                              setNeighborhoodSuggestIdx(null);
                            }}
                            className="w-full text-left px-3 py-2 text-[10px] font-bold text-gray-700 hover:bg-brand/10 hover:text-brand"
                          >
                            {s}
                          </button>
                        ))}
                      </div>
                    )}
                    </div>
                    <div className="flex items-center gap-1 bg-white border border-gray-200 rounded px-2">
                      <span className="text-[10px] font-bold text-gray-500">R$</span>
                      <input
                        type="number"
                        min="0"
                        step="0.01"
                        placeholder="0.00"
                        value={nh.fee === 0 && !nh.name ? '' : nh.fee}
                        onChange={(e) => {
                          const newFees = [...(companyInfo.neighborhoodFees || [])];
                          newFees[idx].fee = Number(e.target.value);
                          setCompanyInfo({ ...companyInfo, neighborhoodFees: newFees });
                        }}
                        className="w-16 bg-transparent border-none py-1.5 px-0 text-[10px] font-bold text-gray-800 focus:ring-0"
                      />
                    </div>
                    <button
                      type="button"
                      onClick={async () => {
                        if (!window.confirm(`Remover "${nh.name || 'este bairro'}" da lista? Isso salva direto no banco de dados, sem precisar clicar em "Salvar Alterações".`)) return;
                        const newFees = [...(companyInfo.neighborhoodFees || [])];
                        newFees.splice(idx, 1);
                        try {
                          await setDoc(doc(db, 'settings', 'company_info'), { neighborhoodFees: newFees }, { merge: true });
                          setCompanyInfo({ ...companyInfo, neighborhoodFees: newFees });
                        } catch (err) {
                          handleFirestoreError(err, OperationType.UPDATE, 'settings/company_info');
                        }
                      }}
                      className="p-1.5 text-red-400 hover:text-red-600 hover:bg-red-50 rounded"
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                  );
                })}
                {(!companyInfo.neighborhoodFees || companyInfo.neighborhoodFees.length === 0) && (
                  <div className="text-center py-4 bg-gray-50 rounded-lg border border-dashed border-gray-200">
                    <p className="text-[10px] font-bold text-gray-400 uppercase tracking-widest">Nenhum bairro configurado</p>
                  </div>
                )}
                {companyInfo.neighborhoodFees && companyInfo.neighborhoodFees.length > 0 && neighborhoodFilterQuery.trim() &&
                  !companyInfo.neighborhoodFees.some(nh => normalizeText(nh.name || '').includes(normalizeText(neighborhoodFilterQuery))) && (
                  <div className="text-center py-4 bg-gray-50 rounded-lg border border-dashed border-gray-200">
                    <p className="text-[10px] font-bold text-gray-400 uppercase tracking-widest">Nenhum bairro encontrado para "{neighborhoodFilterQuery}"</p>
                  </div>
                )}
              </div>
            </div>

            {/* MANUAL OVERRIDE (FORCE CLOSED) */}
            <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 mt-6">
              <div className="flex items-center justify-between">
                <div>
                  <h4 className="text-xs font-black text-amber-950 uppercase tracking-wider">Fechamento Manual (Forçado)</h4>
                  <p className="text-[10px] text-amber-800 font-medium mt-1">Ative para fechar o restaurante imediatamente, ignorando os horários programados. Útil em feriados ou alta demanda.</p>
                </div>
                <label className="relative inline-flex items-center cursor-pointer">
                  <input 
                    type="checkbox" 
                    checked={companyInfo.forceClosed || false}
                    onChange={e => setCompanyInfo(prev => ({ ...prev, forceClosed: e.target.checked }))}
                    className="sr-only peer" 
                  />
                  <div className="w-11 h-6 bg-gray-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-brand"></div>
                </label>
              </div>
            </div>

            {/* WEEKLY OPENING HOURS */}
            <div className="border-t border-gray-100 pt-6 mt-6">
              <h4 className="text-[10px] font-black text-gray-500 uppercase tracking-widest mb-3">Horário de Funcionamento Semanal</h4>
              <p className="text-[10px] text-gray-400 uppercase font-black tracking-wider mb-4">Programe os dias e horários em que o restaurante aceita pedidos de forma automática.</p>
              
              <div className="space-y-3 bg-gray-50/50 rounded-xl border border-gray-100 p-4">
                {DAYS_ORDER.map(dayKey => {
                  const dayHours = (companyInfo.openingHours || DEFAULT_OPENING_HOURS)[dayKey] || { isOpen: false, openTime: '11:00', closeTime: '23:00' };
                  return (
                    <div key={dayKey} className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-2 rounded-lg bg-white border border-gray-100 shadow-xs hover:border-gray-200 transition-colors">
                      <div className="flex items-center gap-3 min-w-[150px]">
                        <input
                          type="checkbox"
                          id={`day-${dayKey}`}
                          checked={dayHours.isOpen}
                          onChange={e => handleDayHoursChange(dayKey, 'isOpen', e.target.checked)}
                          className="w-4 h-4 text-brand border-gray-300 rounded-sm focus:ring-brand focus:ring-2"
                        />
                        <label htmlFor={`day-${dayKey}`} className="text-xs font-black uppercase tracking-wider text-gray-700 cursor-pointer">
                          {DAY_NAMES[dayKey]}
                        </label>
                      </div>

                      <div className={`flex items-center gap-3 transition-opacity duration-200 ${dayHours.isOpen ? 'opacity-100' : 'opacity-40 pointer-events-none'}`}>
                        <div className="flex items-center gap-1.5">
                          <span className="text-[10px] font-black uppercase text-gray-400 tracking-wider">Abre:</span>
                          <input
                            type="time"
                            value={dayHours.openTime}
                            disabled={!dayHours.isOpen}
                            onChange={e => handleDayHoursChange(dayKey, 'openTime', e.target.value)}
                            className="border border-gray-200 rounded-md py-1 px-2 text-xs font-bold text-gray-750 bg-gray-50 focus:ring-brand focus:border-brand"
                          />
                        </div>

                        <div className="flex items-center gap-1.5">
                          <span className="text-[10px] font-black uppercase text-gray-400 tracking-wider">Fecha:</span>
                          <input
                            type="time"
                            value={dayHours.closeTime}
                            disabled={!dayHours.isOpen}
                            onChange={e => handleDayHoursChange(dayKey, 'closeTime', e.target.value)}
                            className="border border-gray-200 rounded-md py-1 px-2 text-xs font-bold text-gray-750 bg-gray-50 focus:ring-brand focus:border-brand"
                          />
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            <div className="pt-4 border-t border-gray-100 flex justify-end">
              <button
                type="submit"
                disabled={savingSettings}
                className="bg-brand text-white text-xs font-black uppercase tracking-widest px-6 py-2.5 rounded-lg hover:bg-brand-dark flex items-center gap-2 transition-colors disabled:opacity-50 shadow-sm"
              >
                {savingSettings ? (
                  <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                ) : (
                  <Save size={16} />
                )}
                <span>Salvar Configurações</span>
              </button>
            </div>
          </form>
        </div>
      )}

      {/* TAB: LOYALTY / REWARDS PROGRAM */}
      {activeTab === 'loyalty' && (
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6 space-y-8">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-sm font-black text-gray-900 uppercase tracking-wider">Programa de Fidelidade</h2>
              <p className="text-[10px] text-gray-500 font-bold uppercase tracking-widest mt-1">Clientes ganham pontos a cada pedido concluído e trocam por descontos</p>
            </div>
            <button
              type="button"
              onClick={() => setCompanyInfo(prev => ({ ...prev, loyaltyEnabled: !prev.loyaltyEnabled }))}
              className={`px-4 py-2 rounded-lg text-[10px] font-black uppercase tracking-widest transition-colors ${
                companyInfo.loyaltyEnabled ? 'bg-emerald-100 text-emerald-700' : 'bg-gray-100 text-gray-500'
              }`}
            >
              {companyInfo.loyaltyEnabled ? 'Ativado' : 'Desativado'}
            </button>
          </div>

          <div>
            <h3 className="text-xs font-black text-gray-900 uppercase tracking-wider mb-1">Forma de ganhar pontos</h3>
            <p className="text-[10px] text-gray-500 font-bold uppercase tracking-widest mb-3">Configure a forma como os clientes ganham pontos</p>
            <div className="flex flex-wrap items-center gap-2 bg-gray-50 border border-gray-100 rounded-xl p-4 text-sm font-bold text-gray-700">
              <span>R$</span>
              <input
                type="number"
                min="1"
                step="0.01"
                value={companyInfo.loyaltySpendPerPoint ?? 10}
                onChange={e => setCompanyInfo(prev => ({ ...prev, loyaltySpendPerPoint: parseFloat(e.target.value) || 1 }))}
                className="w-20 px-2 py-1.5 border border-gray-200 rounded-lg text-center"
              />
              <span>gasto(s) por pedido =</span>
              <Star size={16} className="text-amber-500 fill-amber-500" />
              <input
                type="number"
                min="1"
                step="1"
                value={companyInfo.loyaltyPointsPerUnit ?? 1}
                onChange={e => setCompanyInfo(prev => ({ ...prev, loyaltyPointsPerUnit: parseInt(e.target.value) || 1 }))}
                className="w-16 px-2 py-1.5 border border-gray-200 rounded-lg text-center"
              />
              <span>ponto(s)</span>
            </div>
          </div>

          <div>
            <div className="flex items-center justify-between mb-1">
              <div>
                <h3 className="text-xs font-black text-gray-900 uppercase tracking-wider">Recompensas</h3>
                <p className="text-[10px] text-gray-500 font-bold uppercase tracking-widest">Configure as recompensas que os clientes recebem ao gastar seus pontos</p>
              </div>
              <button
                type="button"
                onClick={() => setCompanyInfo(prev => ({
                  ...prev,
                  loyaltyRewards: [
                    ...(prev.loyaltyRewards || []),
                    { id: `reward-${Date.now()}`, pointsCost: 10, discountType: 'fixed', discountValue: 5, label: formatRewardLabel('fixed', 5) }
                  ]
                }))}
                className="bg-brand text-white p-2 rounded-lg hover:bg-brand-dark transition-colors"
                title="Adicionar recompensa"
              >
                <Plus size={16} />
              </button>
            </div>

            <div className="space-y-2 mt-3">
              {(companyInfo.loyaltyRewards || []).map(reward => (
                <div key={reward.id} className="flex flex-wrap items-center gap-2 bg-gray-50 border border-gray-100 rounded-xl p-3">
                  <div className="flex items-center gap-1.5 shrink-0">
                    <Star size={14} className="text-amber-500 fill-amber-500" />
                    <input
                      type="number"
                      min="1"
                      value={reward.pointsCost}
                      onChange={e => setCompanyInfo(prev => ({
                        ...prev,
                        loyaltyRewards: (prev.loyaltyRewards || []).map(r => r.id === reward.id ? { ...r, pointsCost: parseInt(e.target.value) || 1 } : r)
                      }))}
                      className="w-16 px-2 py-1.5 border border-gray-200 rounded-lg text-center text-xs font-bold"
                    />
                    <span className="text-[10px] text-gray-500 font-bold uppercase">pts</span>
                  </div>

                  <select
                    value={reward.discountType}
                    onChange={e => setCompanyInfo(prev => ({
                      ...prev,
                      loyaltyRewards: (prev.loyaltyRewards || []).map(r => {
                        if (r.id !== reward.id) return r;
                        const discountType = e.target.value as 'fixed' | 'percent';
                        return { ...r, discountType, label: formatRewardLabel(discountType, r.discountValue) };
                      })
                    }))}
                    className="px-2 py-1.5 border border-gray-200 rounded-lg text-xs font-bold shrink-0"
                  >
                    <option value="fixed">R$ Fixo</option>
                    <option value="percent">% Percentual</option>
                  </select>

                  <div className="flex items-center gap-1 shrink-0">
                    {reward.discountType === 'fixed' && <span className="text-xs font-bold text-gray-500">R$</span>}
                    <input
                      type="number"
                      min="0"
                      step="0.01"
                      value={reward.discountValue}
                      onChange={e => setCompanyInfo(prev => ({
                        ...prev,
                        loyaltyRewards: (prev.loyaltyRewards || []).map(r => {
                          if (r.id !== reward.id) return r;
                          const discountValue = parseFloat(e.target.value) || 0;
                          return { ...r, discountValue, label: formatRewardLabel(r.discountType, discountValue) };
                        })
                      }))}
                      className="w-20 px-2 py-1.5 border border-gray-200 rounded-lg text-center text-xs font-bold"
                    />
                    {reward.discountType === 'percent' && <span className="text-xs font-bold text-gray-500">%</span>}
                  </div>

                  <input
                    type="text"
                    value={reward.label}
                    title="Gerado automaticamente a partir do tipo e valor do desconto — edite se quiser um texto diferente"
                    onChange={e => setCompanyInfo(prev => ({
                      ...prev,
                      loyaltyRewards: (prev.loyaltyRewards || []).map(r => r.id === reward.id ? { ...r, label: e.target.value } : r)
                    }))}
                    placeholder="Nome da recompensa (mostrado ao cliente)"
                    className="flex-1 min-w-[160px] px-2 py-1.5 border border-gray-200 rounded-lg text-xs font-bold"
                  />

                  <button
                    type="button"
                    onClick={() => setCompanyInfo(prev => ({
                      ...prev,
                      loyaltyRewards: (prev.loyaltyRewards || []).filter(r => r.id !== reward.id)
                    }))}
                    className="p-1.5 text-red-500 hover:bg-red-50 rounded-md shrink-0"
                    title="Remover"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              ))}
              {(companyInfo.loyaltyRewards || []).length === 0 && (
                <div className="text-center py-6 text-[10px] text-gray-400 uppercase tracking-widest font-bold">
                  Nenhuma recompensa cadastrada.
                </div>
              )}
            </div>
          </div>

          <div className="pt-4 border-t border-gray-100 flex justify-end">
            <button
              type="button"
              onClick={() => handleSaveSettings()}
              disabled={savingSettings}
              className="bg-brand text-white text-xs font-black uppercase tracking-widest px-6 py-2.5 rounded-lg hover:bg-brand-dark flex items-center gap-2 transition-colors disabled:opacity-50 shadow-sm"
            >
              {savingSettings ? (
                <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
              ) : (
                <Save size={16} />
              )}
              <span>Salvar Configurações</span>
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
